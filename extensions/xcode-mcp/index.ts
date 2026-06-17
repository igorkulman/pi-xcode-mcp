import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";

type JsonObject = Record<string, unknown>;
type JsonRpcId = number | string;

type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
};

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

type RegisteredToolInfo = {
  piToolName: string;
  mcpToolName: string;
};

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
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_STORED_STDERR_LINES = 40;
const MAX_TEXT_RESULT_BYTES = DEFAULT_MAX_BYTES;

const BaseMcpCallParams = Type.Object({
  name: Type.String({ description: "Xcode MCP tool name, e.g. RenderPreview, BuildProject, GetBuildLog, or the mirrored Pi tool name, e.g. xcode_render_preview." }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arguments to pass to the MCP tool." })),
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

function stripLeadingXcode(name: string): string {
  return name.replace(/^Xcode(?=[A-Z_\-]|$)/, "");
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toPiToolName(mcpToolName: string): string {
  const normalized = toSnakeCase(stripLeadingXcode(mcpToolName));
  return normalized.startsWith("xcode_") ? normalized : `xcode_${normalized}`;
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

class StdioMcpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private stderrLines: string[] = [];

  constructor(private readonly cwd: string) {}

  get lastStderr(): string {
    return this.stderrLines.join("\n");
  }

  get connected(): boolean {
    return Boolean(this.child && !this.child.killed);
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

    active.stdin.end();

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const termTimer = setTimeout(() => {
        if (!active.killed) active.kill("SIGTERM");
      }, 750);
      const killTimer = setTimeout(() => {
        if (!active.killed) active.kill("SIGKILL");
      }, 2_000);

      active.once("exit", () => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        done();
      });
    });
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

  async callTool(name: string, args: JsonObject, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }, DEFAULT_TOOL_TIMEOUT_MS, signal);
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
  let client: StdioMcpClient | undefined;
  let connectPromise: Promise<void> | undefined;

  const registeredPiToolNames = new Set<string>();
  const toolInfoByPiName = new Map<string, RegisteredToolInfo>();
  const toolInfoByMcpName = new Map<string, RegisteredToolInfo>();

  function setStatus(ctx: { ui: UiLike } | undefined, value: string | undefined): void {
    ctx?.ui.setStatus(STATUS_KEY, value);
  }

  function toolLines(): string[] {
    if (toolInfoByPiName.size === 0) return ["No Xcode MCP tools discovered yet."];

    return Array.from(toolInfoByPiName.values())
      .sort((a, b) => a.piToolName.localeCompare(b.piToolName))
      .map((tool) => `${tool.piToolName} → ${tool.mcpToolName}`);
  }

  function resolveMcpToolName(name: string): string {
    if (toolInfoByMcpName.has(name)) return name;
    return toolInfoByPiName.get(name)?.mcpToolName ?? name;
  }

  async function disconnect(): Promise<void> {
    const active = client;
    client = undefined;
    if (active) await active.close();
  }

  async function discoverTools(ctx?: { ui: UiLike; cwd: string; signal?: AbortSignal }): Promise<number> {
    if (!client) throw new Error("Xcode MCP client is not connected.");

    const tools = await client.listTools(ctx?.signal);
    for (const tool of tools) {
      registerMcpTool(tool);
    }

    setStatus(ctx, `xcode mcp: ${tools.length} tools`);
    return tools.length;
  }

  async function connect(ctx?: { ui: UiLike; cwd: string; signal?: AbortSignal }): Promise<void> {
    await disconnect();

    setStatus(ctx, "xcode mcp: connecting...");
    const nextClient = new StdioMcpClient(ctx?.cwd ?? process.cwd());
    await nextClient.connect(ctx?.signal);
    client = nextClient;

    const count = await discoverTools(ctx);
    setStatus(ctx, `xcode mcp: ${count} tools`);
    ctx?.ui.notify(`Connected to Xcode MCP (${count} tools).`, "info");
  }

  async function ensureConnected(ctx?: { ui: UiLike; cwd: string; signal?: AbortSignal }): Promise<StdioMcpClient> {
    if (client?.connected) return client;

    if (!connectPromise) {
      connectPromise = connect(ctx).finally(() => {
        connectPromise = undefined;
      });
    }

    await connectPromise;

    if (!client?.connected) throw new Error("Failed to connect to Xcode MCP.");
    return client;
  }

  async function callXcodeTool(name: string, args: JsonObject, ctx: { ui: UiLike; cwd: string; signal?: AbortSignal }, onUpdate?: (partial: { content: PiContent[]; details: JsonObject }) => void) {
    const activeClient = await ensureConnected(ctx);
    const mcpToolName = resolveMcpToolName(name);

    onUpdate?.({
      content: [{ type: "text", text: `Calling Xcode MCP tool: ${mcpToolName}...` }],
      details: { mcpTool: mcpToolName },
    });

    const result = await activeClient.callTool(mcpToolName, args, ctx.signal);
    return {
      content: mcpResultToPiContent(result),
      details: { mcpTool: mcpToolName, raw: result },
      isError: Boolean(result.isError),
    };
  }

  function registerMcpTool(tool: McpTool): void {
    const info = { piToolName: toPiToolName(tool.name), mcpToolName: tool.name };
    toolInfoByPiName.set(info.piToolName, info);
    toolInfoByMcpName.set(info.mcpToolName, info);

    if (registeredPiToolNames.has(info.piToolName)) return;
    registeredPiToolNames.add(info.piToolName);

    pi.registerTool({
      name: info.piToolName,
      label: toLabel(tool),
      description: buildToolDescription(tool),
      promptSnippet: `Call Xcode MCP tool ${tool.name}`,
      promptGuidelines: getPromptGuidelines(tool.name, info.piToolName),
      parameters: schemaToTypeBox(tool.inputSchema),
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
        content: [{ type: "text", text: `Connected to Xcode MCP. Discovered tools:\n${toolLines().join("\n")}` }],
        details: { tools: Array.from(toolInfoByPiName.values()) },
      };
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
        ctx.ui.setWidget?.(STATUS_KEY, toolLines());
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
        `Discovered tools: ${toolInfoByPiName.size}`,
        `Bridge stderr: ${client?.lastStderr ? "see below" : "none"}`,
        ...toolLines(),
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
      ctx.ui.setWidget?.(STATUS_KEY, toolLines());
      ctx.ui.notify(`Listed ${toolInfoByPiName.size} Xcode MCP tools`, "info");
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
    await disconnect();
  });
}
