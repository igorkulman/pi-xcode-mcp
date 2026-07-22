import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";

import {
  DEFAULT_TOOL_TIMEOUT_MS,
  McpConnectionGate,
  McpToolCatalog,
  SerialAsyncQueue,
  TOOL_TIMEOUT_ENV_NAME,
  dispatchMcpServerNotification,
  parseToolTimeoutMs,
  reconcileActiveToolNames,
  schemaRequiresArgument,
  selectMatchingXcodeWindow,
  stripLeadingXcode,
  terminateChildProcess,
  toolTimeoutMsForCall,
  type JsonObject,
  type McpTool,
  type McpToolCatalogEntry,
  type XcodeWindow,
} from "./mcp-session.js";

type JsonRpcId = number | string;

type McpContent =
  | { type: "text"; text?: unknown; [key: string]: unknown }
  | { type: "image"; data?: unknown; mimeType?: unknown; [key: string]: unknown }
  | { type: "audio"; data?: unknown; mimeType?: unknown; [key: string]: unknown }
  | { type: "resource"; resource?: unknown; [key: string]: unknown }
  | { type: "resource_link"; uri?: unknown; name?: unknown; description?: unknown; mimeType?: unknown; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

type McpCallResult = {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type UiLike = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, value: string | undefined): void;
  setWidget?(key: string, lines: string[]): void;
};

const STATUS_KEY = "xcode-mcp";
const CLIENT_NAME = "pi-xcode-mcp";
const CLIENT_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const MAX_STORED_STDERR_LINES = 40;
const MAX_TEXT_RESULT_BYTES = DEFAULT_MAX_BYTES;

const BaseMcpCallParams = Type.Object({
  name: Type.String({ description: "Xcode MCP tool name, e.g. RenderPreview, BuildProject, GetBuildLog, or the mirrored Pi tool name, e.g. xcode_render_preview." }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arguments to pass to the MCP tool." })),
});

const BuildWithDiagnosticsParams = Type.Object({
  arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional arguments forwarded to Xcode MCP BuildProject." })),
  includeBuildLog: Type.Optional(Type.Union([
    Type.Literal("onFailure"),
    Type.Literal("always"),
    Type.Literal("never"),
  ], { description: "When to fetch Xcode MCP GetBuildLog after building. Defaults to onFailure." })),
  includeNavigatorIssues: Type.Optional(Type.Boolean({ description: "Also fetch Xcode Issue Navigator diagnostics after a failed build when the tool is available. Defaults to true." })),
});

const RenderPreviewParams = Type.Object({
  sourceFilePath: Type.String({ description: "Path to the SwiftUI source file within the Xcode project organization, e.g. ProjectName/Sources/MyView.swift." }),
  previewDefinitionIndexInFile: Type.Optional(Type.Integer({ description: "Zero-based index of the #Preview macro or PreviewProvider in the source file. Defaults to 0." })),
  previewVariantOverrides: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional preview variant overrides returned by a previous render for the same scheme/destination." })),
  timeout: Type.Optional(Type.Integer({ description: "Seconds to wait for preview rendering. Defaults to Xcode MCP's timeout." })),
  tabIdentifier: Type.Optional(Type.String({ description: "Optional Xcode workspace tab identifier. Usually omitted because Pi resolves it automatically." })),
});

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncateForModel(text: string): string {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: MAX_TEXT_RESULT_BYTES,
  });

  if (!truncation.truncated) return truncation.content;

  return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

function fileUri(path: string): string {
  return `file://${path.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

async function looksLikeXcodeWorkspace(cwd: string): Promise<boolean> {
  let current = cwd;

  for (let depth = 0; depth < 6; depth++) {
    try {
      const entries = await readdir(current, { withFileTypes: true });
      if (
        entries.some((entry) =>
          entry.name === "Package.swift" ||
          entry.name.endsWith(".xcodeproj") ||
          entry.name.endsWith(".xcworkspace"),
        )
      ) {
        return true;
      }
    } catch {
      // Ignore unreadable directories and keep walking up.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return false;
}

function toLabel(tool: McpTool): string {
  const source = tool.title?.trim() || stripLeadingXcode(tool.name);
  return source
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function schemaDescription(schema: JsonObject): string | undefined {
  return typeof schema.description === "string" ? schema.description : undefined;
}

function schemaToTypeBox(schema: unknown): TSchema {
  if (!isObject(schema)) {
    return Type.Record(Type.String(), Type.Any());
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const stringValues = schema.enum.filter((value): value is string => typeof value === "string");
    if (stringValues.length === schema.enum.length) {
      return StringEnum(stringValues as [string, ...string[]]);
    }

    const literalValues = schema.enum.filter((value) => {
      const type = typeof value;
      return type === "string" || type === "number" || type === "boolean";
    });
    if (literalValues.length > 0) {
      return Type.Union(literalValues.map((value) => Type.Literal(value as string | number | boolean)));
    }
  }

  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (variants && variants.length > 0) {
    return Type.Union(variants.map(schemaToTypeBox));
  }

  switch (schema.type) {
    case "string":
      return Type.String({ description: schemaDescription(schema) });
    case "integer":
      return Type.Integer({ description: schemaDescription(schema) });
    case "number":
      return Type.Number({ description: schemaDescription(schema) });
    case "boolean":
      return Type.Boolean({ description: schemaDescription(schema) });
    case "array":
      return Type.Array(schemaToTypeBox(schema.items), { description: schemaDescription(schema) });
    case "object": {
      const properties = isObject(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
      const mapped: Record<string, TSchema> = {};

      for (const [key, value] of Object.entries(properties)) {
        const child = schemaToTypeBox(value);
        mapped[key] = required.has(key) ? child : Type.Optional(child);
      }

      return Type.Object(mapped, {
        additionalProperties: schema.additionalProperties !== false,
        description: schemaDescription(schema),
      });
    }
    default:
      return Type.Any({ description: schemaDescription(schema) });
  }
}

function summarizeSchema(schema: unknown): string | undefined {
  if (!isObject(schema) || !isObject(schema.properties) || Object.keys(schema.properties).length === 0) {
    return undefined;
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  const lines = Object.entries(schema.properties).map(([name, value]) => {
    const property = isObject(value) ? value : {};
    const type = typeof property.type === "string" ? property.type : "any";
    const description = typeof property.description === "string" ? property.description : "";
    return `- ${name}: ${type} (${required.has(name) ? "required" : "optional"})${description ? ` — ${description}` : ""}`;
  });

  return lines.join("\n");
}

function buildToolDescription(tool: McpTool): string {
  const parts = [tool.description?.trim() || `Xcode MCP tool: ${tool.name}`];
  const schemaSummary = summarizeSchema(tool.inputSchema);
  if (schemaSummary) parts.push(`Arguments:\n${schemaSummary}`);
  return parts.join("\n\n");
}

function getPromptGuidelines(mcpToolName: string, piToolName: string): string[] {
  switch (mcpToolName) {
    case "RenderPreview":
      return [
        `Use ${piToolName} when the user asks to inspect, verify, or iterate on a SwiftUI preview visually.`,
        `Use ${piToolName} after UI changes to capture the SwiftUI preview screenshot before judging visual correctness.`,
        `${piToolName} auto-resolves the open Xcode tab and returns the rendered snapshot as an image when Xcode provides previewSnapshotPath.`,
      ];
    case "BuildProject":
      return [`Use ${piToolName} to build the active Xcode scheme when validating Swift or SwiftUI changes.`];
    case "GetBuildLog":
      return [`Use ${piToolName} after BuildProject fails to inspect Xcode build errors and warnings.`];
    case "RunAllTests":
    case "RunSomeTests":
      return [`Use ${piToolName} to validate XCTest or Swift Testing behavior through Xcode when relevant.`];
    case "XcodeListNavigatorIssues":
    case "XcodeRefreshCodeIssuesInFile":
      return [`Use ${piToolName} to inspect Xcode diagnostics and Issue Navigator problems.`];
    case "DocumentationSearch":
      return [`Use ${piToolName} to search Apple documentation and WWDC transcript context for Swift, SwiftUI, and Apple SDK APIs.`];
    default:
      return [`Use ${piToolName} when Xcode MCP can provide better project, build, test, preview, or Apple documentation context than shell commands.`];
  }
}

function contentBlockToPi(block: McpContent): PiContent[] {
  if (block.type === "text") {
    return [{ type: "text", text: truncateForModel(typeof block.text === "string" ? block.text : stringify(block)) }];
  }

  if (block.type === "image" && typeof block.data === "string") {
    return [{ type: "image", data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" }];
  }

  if (block.type === "resource" && isObject(block.resource)) {
    const resource = block.resource as JsonObject;
    const header = `[resource: ${typeof resource.uri === "string" ? resource.uri : "embedded"}${typeof resource.mimeType === "string" ? `, ${resource.mimeType}` : ""}]`;
    if (typeof resource.text === "string") {
      return [{ type: "text", text: truncateForModel(`${header}\n${resource.text}`) }];
    }
    if (typeof resource.blob === "string" && typeof resource.mimeType === "string" && resource.mimeType.startsWith("image/")) {
      return [{ type: "image", data: resource.blob, mimeType: resource.mimeType }];
    }
    return [{ type: "text", text: truncateForModel(`${header}\n${stringify(resource)}`) }];
  }

  if (block.type === "resource_link") {
    const label = typeof block.name === "string" ? block.name : "resource";
    const uri = typeof block.uri === "string" ? block.uri : "unknown-uri";
    const description = typeof block.description === "string" ? ` — ${block.description}` : "";
    return [{ type: "text", text: `[resource link: ${label}] ${uri}${description}` }];
  }

  if (block.type === "audio") {
    return [{ type: "text", text: `[audio content: ${typeof block.mimeType === "string" ? block.mimeType : "unknown mime type"}]` }];
  }

  return [{ type: "text", text: truncateForModel(stringify(block)) }];
}

function mcpResultToPiContent(result: McpCallResult): PiContent[] {
  const blocks: PiContent[] = [];

  for (const item of result.content ?? []) {
    blocks.push(...contentBlockToPi(item));
  }

  if (result.structuredContent !== undefined) {
    blocks.push({ type: "text", text: truncateForModel(`Structured content:\n${stringify(result.structuredContent)}`) });
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: truncateForModel(stringify(result)) });
  }

  if (result.isError) {
    const firstText = blocks.find((block): block is { type: "text"; text: string } => block.type === "text");
    if (firstText) {
      firstText.text = `Xcode MCP returned an error:\n\n${firstText.text}`;
    } else {
      blocks.unshift({ type: "text", text: "Xcode MCP returned an error." });
    }
  }

  return blocks;
}

function mcpResultText(result: McpCallResult): string {
  const parts: string[] = [];

  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type !== "image") {
      parts.push(stringify(item));
    }
  }

  if (result.structuredContent !== undefined) {
    parts.push(stringify(result.structuredContent));
  }

  return parts.join("\n");
}

function structuredContentIndicatesFailure(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(structuredContentIndicatesFailure);
  }

  if (!isObject(value)) {
    return false;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (typeof child === "boolean" && child === false && ["success", "succeeded", "buildsucceeded", "passed"].includes(normalizedKey)) {
      return true;
    }

    if (typeof child === "string" && /(status|state|result|outcome)/i.test(key) && /\b(failed|failure|error)\b/i.test(child)) {
      return true;
    }

    if (structuredContentIndicatesFailure(child)) {
      return true;
    }
  }

  return false;
}

function resultIndicatesBuildFailure(result: McpCallResult): boolean {
  if (result.isError) return true;
  if (structuredContentIndicatesFailure(result.structuredContent)) return true;

  return /\b(build failed|failed to build|compilation failed|compile failed|link failed|fatal error:)\b|\berror:/i.test(mcpResultText(result));
}

function sectionedContent(title: string, result: McpCallResult): PiContent[] {
  const blocks = mcpResultToPiContent(result);
  const firstText = blocks.find((block): block is { type: "text"; text: string } => block.type === "text");

  if (firstText) {
    firstText.text = `## ${title}\n\n${firstText.text}`;
  } else {
    blocks.unshift({ type: "text", text: `## ${title}` });
  }

  return blocks;
}

function mcpToolErrorResult(toolName: string, error: unknown): McpCallResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: `${toolName} failed: ${message}` }],
  };
}

function piInputSchemaWithAutoResolvedTabIdentifier(schema: unknown): unknown {
  if (!schemaRequiresArgument(schema, "tabIdentifier") || !isObject(schema)) return schema;

  const required = Array.isArray(schema.required) ? schema.required.filter((item) => item !== "tabIdentifier") : [];
  return {
    ...schema,
    required,
  };
}

function collectStringsFromMcpResult(result: McpCallResult): string[] {
  const strings: string[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      strings.push(value);
      try {
        visit(JSON.parse(value));
      } catch {
        // Not JSON; keep the original string only.
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (isObject(value)) {
      for (const child of Object.values(value)) visit(child);
    }
  };

  visit(result.content ?? []);
  visit(result.structuredContent);
  return strings;
}

function extractWindowsFromValue(value: unknown, windows: XcodeWindow[]): void {
  if (Array.isArray(value)) {
    for (const item of value) extractWindowsFromValue(item, windows);
    return;
  }

  if (!isObject(value)) return;

  if (typeof value.tabIdentifier === "string") {
    windows.push({
      tabIdentifier: value.tabIdentifier,
      workspacePath: typeof value.workspacePath === "string" ? value.workspacePath : undefined,
    });
  }

  for (const child of Object.values(value)) {
    extractWindowsFromValue(child, windows);
  }
}

function parseXcodeWindows(result: McpCallResult): XcodeWindow[] {
  const windows: XcodeWindow[] = [];
  extractWindowsFromValue(result.structuredContent, windows);

  for (const text of collectStringsFromMcpResult(result)) {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/tabIdentifier:\s*([^,\s]+)(?:,\s*workspacePath:\s*(.+))?/);
      if (match) {
        windows.push({ tabIdentifier: match[1], workspacePath: match[2]?.trim() });
      }
    }
  }

  const byIdentifier = new Map<string, XcodeWindow>();
  for (const window of windows) {
    const existing = byIdentifier.get(window.tabIdentifier);
    byIdentifier.set(window.tabIdentifier, {
      tabIdentifier: window.tabIdentifier,
      workspacePath: existing?.workspacePath ?? window.workspacePath,
    });
  }

  return Array.from(byIdentifier.values());
}

function formatXcodeWindows(windows: XcodeWindow[]): string {
  return windows
    .map((window) => `- ${window.tabIdentifier}${window.workspacePath ? ` — ${window.workspacePath}` : ""}`)
    .join("\n");
}

function collectPreviewSnapshotPaths(value: unknown, paths: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPreviewSnapshotPaths(item, paths);
    return;
  }

  if (!isObject(value)) return;

  if (typeof value.previewSnapshotPath === "string" && value.previewSnapshotPath.trim()) {
    paths.push(value.previewSnapshotPath);
  }

  for (const child of Object.values(value)) {
    collectPreviewSnapshotPaths(child, paths);
  }
}

function previewSnapshotPaths(result: McpCallResult): string[] {
  const paths: string[] = [];
  collectPreviewSnapshotPaths(result.structuredContent, paths);

  for (const text of collectStringsFromMcpResult(result)) {
    try {
      collectPreviewSnapshotPaths(JSON.parse(text), paths);
    } catch {
      const match = text.match(/"previewSnapshotPath"\s*:\s*"([^"]+)"/);
      if (match) paths.push(match[1].replace(/\\\//g, "/"));
    }
  }

  return Array.from(new Set(paths));
}

function imageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

async function appendPreviewSnapshotImages(content: PiContent[], result: McpCallResult): Promise<void> {
  const paths = previewSnapshotPaths(result);
  if (paths.length === 0) return;

  for (const path of paths) {
    try {
      const image = await readFile(path);
      content.push({ type: "text", text: `SwiftUI preview snapshot: ${path}` });
      content.push({ type: "image", data: image.toString("base64"), mimeType: imageMimeType(path) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      content.push({ type: "text", text: `SwiftUI preview snapshot was rendered at ${path}, but Pi could not read it: ${message}` });
    }
  }
}

function previewResultIndicatesFailure(result: McpCallResult): boolean {
  if (result.isError) return true;

  const hasErrorsField = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(hasErrorsField);
    if (!isObject(value)) return false;

    for (const [key, child] of Object.entries(value)) {
      if (key === "errors" && Array.isArray(child) && child.length > 0) return true;
      if (hasErrorsField(child)) return true;
    }

    return false;
  };

  return hasErrorsField(result.structuredContent);
}

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private stderrLines: string[] = [];
  private toolsChangedHandler: (() => void) | undefined;

  constructor(
    private readonly cwd: string,
    private readonly defaultToolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  ) {}

  get lastStderr(): string {
    return this.stderrLines.join("\n");
  }

  get connected(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  setToolsChangedHandler(handler: (() => void) | undefined): void {
    this.toolsChangedHandler = handler;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.child) return;

    this.child = spawn("xcrun", ["mcpbridge"], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.stderrLines.push(line);
      }
      if (this.stderrLines.length > MAX_STORED_STDERR_LINES) {
        this.stderrLines.splice(0, this.stderrLines.length - MAX_STORED_STDERR_LINES);
      }
    });

    this.child.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
    this.child.on("exit", (code, signalName) => {
      const suffix = signalName ? `signal ${signalName}` : `code ${code ?? "unknown"}`;
      this.rejectAll(new Error(`xcrun mcpbridge exited (${suffix}).${this.lastStderr ? `\n${this.lastStderr}` : ""}`));
      this.child = undefined;
    });

    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          roots: { listChanged: false },
        },
        clientInfo: {
          name: CLIENT_NAME,
          title: "Pi Xcode MCP",
          version: CLIENT_VERSION,
        },
      },
      DEFAULT_CONNECT_TIMEOUT_MS,
      signal,
    );

    this.notify("notifications/initialized");
  }

  async close(): Promise<void> {
    const active = this.child;
    this.child = undefined;
    this.rejectAll(new Error("Xcode MCP connection closed."));

    if (!active) return;
    await terminateChildProcess(active);
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, DEFAULT_CONNECT_TIMEOUT_MS, signal);
      const page = isObject(result) ? result : {};
      const pageTools = Array.isArray(page.tools) ? page.tools.filter(isObject) as McpTool[] : [];
      tools.push(...pageTools);
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor);

    return tools;
  }

  async callTool(
    name: string,
    args: JsonObject,
    signal?: AbortSignal,
    timeoutMs = this.defaultToolTimeoutMs,
  ): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs, signal);
    return isObject(result) ? result as McpCallResult : { content: [{ type: "text", text: stringify(result) }] };
  }

  private request(method: string, params?: unknown, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonObject = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Xcode MCP request cancelled."));
        return;
      }

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "Request timed out in Pi." });
        reject(new Error(`Xcode MCP request timed out: ${method}`));
      }, timeoutMs);

      const abortHandler = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: "Request cancelled in Pi." });
        reject(new Error(`Xcode MCP request cancelled: ${method}`));
      };

      signal?.addEventListener("abort", abortHandler, { once: true });

      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abortHandler);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abortHandler);
          reject(error);
        },
        timeout,
      });

      try {
        this.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abortHandler);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    const payload: JsonObject = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.send(payload);
  }

  private send(payload: JsonObject): void {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Xcode MCP bridge is not running.");
    }

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch (error) {
        this.stderrLines.push(`Invalid MCP JSON from stdout: ${line.slice(0, 500)}`);
        continue;
      }

      this.handleMessage(message);
    }
  }

  private handleMessage(message: JsonObject): void {
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id as JsonRpcId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(message.id as JsonRpcId);

      if (isObject(message.error)) {
        const errorMessage = typeof message.error.message === "string" ? message.error.message : stringify(message.error);
        pending.reject(new Error(errorMessage));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (dispatchMcpServerNotification(message, { toolsListChanged: this.toolsChangedHandler })) {
      return;
    }

    if (typeof message.method === "string" && message.id !== undefined) {
      this.handleServerRequest(message.id as JsonRpcId, message.method, message.params);
    }
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === "ping") {
      this.send({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "roots/list") {
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          roots: [{ uri: fileUri(this.cwd), name: basename(this.cwd) || this.cwd }],
        },
      });
      return;
    }

    this.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Pi Xcode MCP client does not implement server request: ${method}`,
        data: params,
      },
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export default function xcodeMcpExtension(pi: ExtensionAPI) {
  const defaultToolTimeoutMs = parseToolTimeoutMs(process.env[TOOL_TIMEOUT_ENV_NAME]);
  let client: StdioMcpClient | undefined;
  let latestConnectPromise: Promise<void> | undefined;

  const connectionGate = new McpConnectionGate();
  const connectionQueue = new SerialAsyncQueue();
  const toolCatalog = new McpToolCatalog(["xcode_build", "xcode_render_preview"]);
  const toolRefreshQueue = new SerialAsyncQueue();

  function setStatus(ctx: { ui: UiLike } | undefined, value: string | undefined): void {
    ctx?.ui.setStatus(STATUS_KEY, value);
  }

  async function listXcodeWindows(activeClient: StdioMcpClient, signal?: AbortSignal): Promise<XcodeWindow[]> {
    const listWindowsToolName = toolCatalog.findMcpToolName("XcodeListWindows", "ListWindows");
    if (!listWindowsToolName) return [];

    const result = await activeClient.callTool(listWindowsToolName, {}, signal);
    return parseXcodeWindows(result);
  }

  async function resolveTabIdentifier(activeClient: StdioMcpClient, args: JsonObject, ctx: { cwd: string; signal?: AbortSignal }): Promise<string> {
    if (typeof args.tabIdentifier === "string" && args.tabIdentifier.trim()) {
      return args.tabIdentifier;
    }

    const windows = await listXcodeWindows(activeClient, ctx.signal);
    if (windows.length === 0) {
      throw new Error("Xcode MCP requires tabIdentifier, but no Xcode windows were returned by XcodeListWindows.");
    }

    const selectedWindow = selectMatchingXcodeWindow(windows, ctx.cwd);
    if (selectedWindow) return selectedWindow.tabIdentifier;

    throw new Error(
      `Xcode MCP requires tabIdentifier, but no unique Xcode workspace tab matches ${ctx.cwd}. ` +
      `Open this worktree in Xcode or pass { "tabIdentifier": "..." } explicitly. Open windows:\n${formatXcodeWindows(windows)}`,
    );
  }

  async function argumentsWithResolvedTabIdentifier(
    activeClient: StdioMcpClient,
    mcpToolName: string,
    args: JsonObject,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<JsonObject> {
    if (!toolCatalog.requiresArgument(mcpToolName, "tabIdentifier")) return args;
    if (typeof args.tabIdentifier === "string" && args.tabIdentifier.trim()) return args;

    return {
      ...args,
      tabIdentifier: await resolveTabIdentifier(activeClient, args, ctx),
    };
  }

  async function closeClient(targetClient: StdioMcpClient): Promise<void> {
    targetClient.setToolsChangedHandler(undefined);
    if (client === targetClient) client = undefined;
    await targetClient.close();
  }

  async function closeCurrentClient(): Promise<void> {
    const activeClient = client;
    if (activeClient) await closeClient(activeClient);
  }

  async function disconnect(): Promise<void> {
    connectionGate.cancelPending();
    await closeCurrentClient();
  }

  async function discoverTools(
    ctx: { ui: UiLike; cwd: string; signal?: AbortSignal } | undefined,
    activeClient: StdioMcpClient,
    shouldApply: () => boolean,
  ): Promise<number | undefined> {
    const tools = await activeClient.listTools(ctx?.signal);
    if (!shouldApply()) return undefined;

    const change = toolCatalog.replace(tools);
    for (const entry of change.registrations) {
      registerMcpTool(entry);
    }

    if (change.addedPiToolNames.length > 0 || change.removedPiToolNames.length > 0) {
      pi.setActiveTools(reconcileActiveToolNames(pi.getActiveTools(), change));
    }

    setStatus(ctx, `xcode mcp: ${tools.length} tools`);
    return tools.length;
  }

  function refreshToolCatalog(
    sourceClient: StdioMcpClient,
    ctx?: { ui: UiLike; cwd: string; signal?: AbortSignal },
    connectionGeneration?: number,
  ): Promise<number | undefined> {
    const shouldApply = () => (
      client === sourceClient
      && sourceClient.connected
      && (connectionGeneration === undefined || connectionGate.isCurrent(connectionGeneration))
    );

    return toolRefreshQueue.enqueue(async () => {
      if (!shouldApply()) return undefined;
      return discoverTools(ctx, sourceClient, shouldApply);
    });
  }

  function queueToolCatalogRefresh(sourceClient: StdioMcpClient): void {
    void refreshToolCatalog(sourceClient).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-xcode-mcp] Failed to refresh Xcode MCP tools: ${message}`);
    });
  }

  async function performConnect(
    connectionGeneration: number,
    ctx?: { ui: UiLike; cwd: string; signal?: AbortSignal },
  ): Promise<void> {
    connectionGate.assertCurrent(connectionGeneration);
    await closeCurrentClient();
    connectionGate.assertCurrent(connectionGeneration);

    setStatus(ctx, "xcode mcp: connecting...");
    const nextClient = new StdioMcpClient(ctx?.cwd ?? process.cwd(), defaultToolTimeoutMs);
    client = nextClient;

    try {
      await nextClient.connect(ctx?.signal);
      connectionGate.assertCurrent(connectionGeneration);
      if (client !== nextClient) {
        throw new Error("Xcode MCP connection attempt was superseded or cancelled.");
      }

      nextClient.setToolsChangedHandler(() => queueToolCatalogRefresh(nextClient));
      const count = await refreshToolCatalog(nextClient, ctx, connectionGeneration);
      connectionGate.assertCurrent(connectionGeneration);
      if (count === undefined || client !== nextClient) {
        throw new Error("Xcode MCP connection attempt was superseded or cancelled.");
      }

      setStatus(ctx, `xcode mcp: ${count} tools`);
      ctx?.ui.notify(`Connected to Xcode MCP (${count} tools).`, "info");
    } catch (error) {
      try {
        await closeClient(nextClient);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Xcode MCP connection failed and its bridge process could not be cleaned up.",
        );
      }
      throw error;
    }
  }

  function connect(ctx?: { ui: UiLike; cwd: string; signal?: AbortSignal }): Promise<void> {
    let connectionGeneration: number;
    try {
      connectionGeneration = connectionGate.beginConnection();
    } catch (error) {
      return Promise.reject(error);
    }

    const operation = connectionQueue.enqueue(() => performConnect(connectionGeneration, ctx));
    latestConnectPromise = operation;
    const clearLatest = () => {
      if (latestConnectPromise === operation) latestConnectPromise = undefined;
    };
    void operation.then(clearLatest, clearLatest);
    return operation;
  }

  async function ensureConnected(ctx?: { ui: UiLike; cwd: string; signal?: AbortSignal }): Promise<StdioMcpClient> {
    const pendingConnection = latestConnectPromise;
    if (pendingConnection) await pendingConnection;
    if (client?.connected) return client;

    await connect(ctx);
    if (!client?.connected) throw new Error("Failed to connect to Xcode MCP.");
    return client;
  }

  async function callXcodeTool(name: string, args: JsonObject, ctx: { ui: UiLike; cwd: string; signal?: AbortSignal }, onUpdate?: (partial: { content: PiContent[]; details: JsonObject }) => void) {
    const activeClient = await ensureConnected(ctx);
    const mcpToolName = toolCatalog.resolveMcpToolName(name);
    const resolvedArgs = await argumentsWithResolvedTabIdentifier(activeClient, mcpToolName, args, ctx);

    onUpdate?.({
      content: [{ type: "text", text: `Calling Xcode MCP tool: ${mcpToolName}...` }],
      details: { mcpTool: mcpToolName, arguments: resolvedArgs },
    });

    const timeoutMs = toolTimeoutMsForCall(mcpToolName, resolvedArgs, defaultToolTimeoutMs);
    const result = await activeClient.callTool(mcpToolName, resolvedArgs, ctx.signal, timeoutMs);
    const content = mcpResultToPiContent(result);
    const isPreviewTool = mcpToolName === "RenderPreview";
    if (isPreviewTool) {
      await appendPreviewSnapshotImages(content, result);
    }

    return {
      content,
      details: { mcpTool: mcpToolName, arguments: resolvedArgs, raw: result },
      isError: isPreviewTool ? previewResultIndicatesFailure(result) : Boolean(result.isError),
    };
  }

  async function renderPreview(
    params: JsonObject,
    ctx: { ui: UiLike; cwd: string; signal?: AbortSignal },
    onUpdate?: (partial: { content: PiContent[]; details: JsonObject }) => void,
  ) {
    const activeClient = await ensureConnected(ctx);
    const renderPreviewToolName = toolCatalog.findMcpToolName("RenderPreview", "XcodeRenderPreview");

    if (!renderPreviewToolName) {
      throw new Error(`Xcode MCP did not advertise a SwiftUI preview render tool. Discovered tools:\n${toolCatalog.lines().join("\n")}`);
    }

    const renderArgs = await argumentsWithResolvedTabIdentifier(activeClient, renderPreviewToolName, params, ctx);

    onUpdate?.({
      content: [{ type: "text", text: `Rendering SwiftUI preview through Xcode MCP (${renderPreviewToolName})...` }],
      details: { renderPreviewTool: renderPreviewToolName, arguments: renderArgs },
    });

    const timeoutMs = toolTimeoutMsForCall(renderPreviewToolName, renderArgs, defaultToolTimeoutMs);
    const result = await activeClient.callTool(renderPreviewToolName, renderArgs, ctx.signal, timeoutMs);
    const content = mcpResultToPiContent(result);
    await appendPreviewSnapshotImages(content, result);

    return {
      content,
      details: { renderPreviewTool: renderPreviewToolName, arguments: renderArgs, raw: result },
      isError: previewResultIndicatesFailure(result),
    };
  }

  async function buildWithDiagnostics(
    params: { arguments?: JsonObject; includeBuildLog?: "onFailure" | "always" | "never"; includeNavigatorIssues?: boolean },
    ctx: { ui: UiLike; cwd: string; signal?: AbortSignal },
    onUpdate?: (partial: { content: PiContent[]; details: JsonObject }) => void,
  ) {
    const activeClient = await ensureConnected(ctx);
    const buildToolName = toolCatalog.findMcpToolName("BuildProject", "XcodeBuildProject", "XcodeBuild");

    if (!buildToolName) {
      throw new Error(`Xcode MCP did not advertise a build tool. Discovered tools:\n${toolCatalog.lines().join("\n")}`);
    }

    const buildArgs = await argumentsWithResolvedTabIdentifier(activeClient, buildToolName, params.arguments ?? {}, ctx);

    onUpdate?.({
      content: [{ type: "text", text: `Building active Xcode scheme through Xcode MCP (${buildToolName})...` }],
      details: { buildTool: buildToolName, arguments: buildArgs },
    });

    let buildResult: McpCallResult;
    try {
      buildResult = await activeClient.callTool(buildToolName, buildArgs, ctx.signal);
    } catch (error) {
      buildResult = mcpToolErrorResult(buildToolName, error);
    }

    const buildFailed = resultIndicatesBuildFailure(buildResult);
    const includeBuildLog = params.includeBuildLog ?? "onFailure";
    const includeNavigatorIssues = params.includeNavigatorIssues ?? true;
    const shouldFetchBuildLog = includeBuildLog === "always" || (includeBuildLog === "onFailure" && buildFailed);
    const content: PiContent[] = [
      {
        type: "text",
        text: buildFailed
          ? "Xcode MCP build reported a failure. I fetched available Xcode diagnostics below."
          : "Xcode MCP build completed without detected build errors.",
      },
      ...sectionedContent("BuildProject", buildResult),
    ];
    const details: JsonObject = {
      buildTool: buildToolName,
      buildArguments: buildArgs,
      buildFailed,
      buildResult,
    };
    const diagnosticBaseArgs: JsonObject = typeof buildArgs.tabIdentifier === "string" ? { tabIdentifier: buildArgs.tabIdentifier } : {};

    if (shouldFetchBuildLog) {
      const buildLogToolName = toolCatalog.findMcpToolName("GetBuildLog", "XcodeGetBuildLog");
      if (buildLogToolName) {
        const buildLogArgs = await argumentsWithResolvedTabIdentifier(activeClient, buildLogToolName, diagnosticBaseArgs, ctx);

        onUpdate?.({
          content: [{ type: "text", text: `Fetching Xcode build log through MCP (${buildLogToolName})...` }],
          details: { buildTool: buildToolName, buildLogTool: buildLogToolName, buildFailed, arguments: buildLogArgs },
        });

        let buildLogResult: McpCallResult;
        try {
          buildLogResult = await activeClient.callTool(buildLogToolName, buildLogArgs, ctx.signal);
        } catch (error) {
          buildLogResult = mcpToolErrorResult(buildLogToolName, error);
        }
        content.push(...sectionedContent("GetBuildLog", buildLogResult));
        details.buildLogTool = buildLogToolName;
        details.buildLogArguments = buildLogArgs;
        details.buildLogResult = buildLogResult;
      } else {
        content.push({ type: "text", text: "## GetBuildLog\n\nXcode MCP did not advertise a GetBuildLog tool." });
      }
    }

    if (buildFailed && includeNavigatorIssues) {
      const navigatorIssuesToolName = toolCatalog.findMcpToolName("XcodeListNavigatorIssues", "ListNavigatorIssues");
      if (navigatorIssuesToolName) {
        const navigatorIssuesArgs = await argumentsWithResolvedTabIdentifier(activeClient, navigatorIssuesToolName, diagnosticBaseArgs, ctx);

        onUpdate?.({
          content: [{ type: "text", text: `Fetching Xcode Issue Navigator diagnostics through MCP (${navigatorIssuesToolName})...` }],
          details: { buildTool: buildToolName, navigatorIssuesTool: navigatorIssuesToolName, buildFailed, arguments: navigatorIssuesArgs },
        });

        let navigatorIssuesResult: McpCallResult;
        try {
          navigatorIssuesResult = await activeClient.callTool(navigatorIssuesToolName, navigatorIssuesArgs, ctx.signal);
        } catch (error) {
          navigatorIssuesResult = mcpToolErrorResult(navigatorIssuesToolName, error);
        }
        content.push(...sectionedContent("Issue Navigator", navigatorIssuesResult));
        details.navigatorIssuesTool = navigatorIssuesToolName;
        details.navigatorIssuesArguments = navigatorIssuesArgs;
        details.navigatorIssuesResult = navigatorIssuesResult;
      }
    }

    return {
      content,
      details,
      isError: buildFailed,
    };
  }

  function registerMcpTool(entry: McpToolCatalogEntry): void {
    const { info, tool } = entry;
    const piInputSchema = piInputSchemaWithAutoResolvedTabIdentifier(tool.inputSchema);

    pi.registerTool({
      name: info.piToolName,
      label: toLabel(tool),
      description: buildToolDescription({ ...tool, inputSchema: isObject(piInputSchema) ? piInputSchema : tool.inputSchema }),
      promptSnippet: `Call Xcode MCP tool ${tool.name}`,
      promptGuidelines: getPromptGuidelines(tool.name, info.piToolName),
      parameters: schemaToTypeBox(piInputSchema),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        return callXcodeTool(tool.name, (params ?? {}) as JsonObject, { ui: ctx.ui, cwd: ctx.cwd, signal }, onUpdate);
      },
    });
  }

  pi.registerTool({
    name: "xcode_mcp_connect",
    label: "Xcode MCP Connect",
    description: "Connect or reconnect to Xcode's built-in MCP server through `xcrun mcpbridge`, then discover and mirror its tools into Pi.",
    promptSnippet: "Connect to Xcode MCP and discover available Xcode tools",
    promptGuidelines: [
      "Use xcode_mcp_connect when the user asks to use Xcode MCP but no specific xcode_* MCP tools are available yet.",
      "After xcode_mcp_connect succeeds, prefer the specific mirrored xcode_* tool for build, test, diagnostics, docs, and SwiftUI preview work.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      await connect({ ui: ctx.ui, cwd: ctx.cwd, signal });
      return {
        content: [{ type: "text", text: `Connected to Xcode MCP. Discovered tools:\n${toolCatalog.lines().join("\n")}` }],
        details: { tools: toolCatalog.values() },
      };
    },
  });

  pi.registerTool({
    name: "xcode_render_preview",
    label: "Render SwiftUI Preview",
    description: "Render a SwiftUI preview through Xcode MCP, auto-resolve the open Xcode tab, and attach Xcode's rendered preview snapshot image to the tool result.",
    promptSnippet: "Render a SwiftUI preview screenshot through Xcode MCP",
    promptGuidelines: [
      "Use xcode_render_preview when the user asks to inspect, verify, or iterate on a SwiftUI preview visually.",
      "Use xcode_render_preview after SwiftUI UI changes to capture the rendered preview screenshot before judging visual correctness.",
      "xcode_render_preview auto-resolves the open Xcode tab and returns the rendered snapshot as an image when Xcode provides previewSnapshotPath.",
    ],
    parameters: RenderPreviewParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return renderPreview(params, { ui: ctx.ui, cwd: ctx.cwd, signal }, onUpdate);
    },
  });

  pi.registerTool({
    name: "xcode_build",
    label: "Xcode Build",
    description: "Build the active Xcode scheme through Xcode MCP, then automatically fetch Xcode build errors and diagnostics when the build fails. This is usually faster and more project-aware than shelling out to xcodebuild because it uses the running Xcode instance.",
    promptSnippet: "Build the active Xcode scheme through Xcode MCP and fetch errors on failure",
    promptGuidelines: [
      "Prefer xcode_build over shell xcodebuild when validating Swift, SwiftUI, or Xcode project changes and Xcode MCP is available.",
      "Use xcode_build to build through the running Xcode instance and automatically retrieve GetBuildLog/Issue Navigator diagnostics on failure.",
      "Only fall back to shell xcodebuild when Xcode MCP is unavailable or the user explicitly asks for command-line xcodebuild.",
    ],
    parameters: BuildWithDiagnosticsParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return buildWithDiagnostics(params, { ui: ctx.ui, cwd: ctx.cwd, signal }, onUpdate);
    },
  });

  pi.registerTool({
    name: "xcode_mcp_call",
    label: "Xcode MCP Call",
    description: "Call any Xcode MCP tool by name. Use xcode_mcp_connect first if you need to discover tool names and schemas.",
    promptSnippet: "Call an arbitrary Xcode MCP tool by name",
    promptGuidelines: [
      "Use xcode_mcp_call only when a more specific mirrored xcode_* tool is unavailable.",
      "For SwiftUI previews, prefer xcode_render_preview when it has been discovered; otherwise call xcode_mcp_call with name RenderPreview.",
    ],
    parameters: BaseMcpCallParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return callXcodeTool(params.name, (params.arguments ?? {}) as JsonObject, { ui: ctx.ui, cwd: ctx.cwd, signal }, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    setStatus(ctx, "xcode mcp: idle");

    if (process.env.XCODE_MCP_AUTOCONNECT === "0" || process.env.XCODE_MCP_AUTOCONNECT === "false") {
      setStatus(ctx, "xcode mcp: manual");
      return;
    }

    const shouldAutoConnect =
      process.env.XCODE_MCP_AUTOCONNECT === "1" ||
      process.env.XCODE_MCP_AUTOCONNECT === "true" ||
      (await looksLikeXcodeWorkspace(ctx.cwd));

    if (!shouldAutoConnect) {
      setStatus(ctx, "xcode mcp: inactive");
      return;
    }

    const xcodeProcess = await pi.exec("pgrep", ["-x", "Xcode"], { timeout: 1_000 });
    if (xcodeProcess.code !== 0) {
      setStatus(ctx, "xcode mcp: Xcode closed");
      return;
    }

    try {
      await ensureConnected({ ui: ctx.ui, cwd: ctx.cwd, signal: ctx.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(ctx, "xcode mcp: offline");
      ctx.ui.notify(
        `Xcode MCP is offline. Open Xcode with a project, enable Settings > Intelligence > Model Context Protocol, approve the connection, then run /xcode-mcp-connect. (${message})`,
        "warning",
      );
    }
  });

  pi.registerCommand("xcode-mcp-connect", {
    description: "Connect or reconnect to Xcode MCP and discover tools",
    handler: async (_args, ctx) => {
      try {
        await connect({ ui: ctx.ui, cwd: ctx.cwd, signal: ctx.signal });
        ctx.ui.setWidget?.(STATUS_KEY, toolCatalog.lines());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(ctx, "xcode mcp: offline");
        ctx.ui.notify(`Failed to connect to Xcode MCP: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("xcode-mcp-status", {
    description: "Show Xcode MCP connection status and discovered tools",
    handler: async (_args, ctx) => {
      const lines = [
        `Connected: ${client?.connected ? "yes" : "no"}`,
        `Discovered tools: ${toolCatalog.size}`,
        `Bridge stderr: ${client?.lastStderr ? "see below" : "none"}`,
        ...toolCatalog.lines(),
      ];

      if (client?.lastStderr) {
        lines.push("", ...client.lastStderr.split("\n"));
      }

      ctx.ui.setWidget?.(STATUS_KEY, lines);
      ctx.ui.notify(`Xcode MCP ${client?.connected ? "connected" : "offline"}`, client?.connected ? "info" : "warning");
    },
  });

  pi.registerCommand("xcode-mcp-list-tools", {
    description: "List mirrored Pi tools from Xcode MCP",
    handler: async (_args, ctx) => {
      ctx.ui.setWidget?.(STATUS_KEY, toolCatalog.lines());
      ctx.ui.notify(`Listed ${toolCatalog.size} Xcode MCP tools`, "info");
    },
  });

  pi.registerCommand("xcode-mcp-disconnect", {
    description: "Disconnect from Xcode MCP",
    handler: async (_args, ctx) => {
      await disconnect();
      setStatus(ctx, "xcode mcp: disconnected");
      ctx.ui.notify("Disconnected from Xcode MCP", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    connectionGate.shutdown();
    await closeCurrentClient();
    await Promise.all([connectionQueue.onIdle(), toolRefreshQueue.onIdle()]);
    await closeCurrentClient();
  });
}
