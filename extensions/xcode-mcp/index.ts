import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

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
  inputSchema?: JsonObject;
};

export type XcodeWorkspace = {
  workspaceIdentifier: string;
  workspacePath?: string;
};

type UiLike = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, value: string | undefined): void;
  setWidget?(key: string, lines: string[]): void;
};

type HeadlessMcpServerState = "running" | "stopped" | "disabled" | "unavailable";

const STATUS_KEY = "xcode-mcp";
const CLIENT_NAME = "pi-xcode-mcp";
const CLIENT_VERSION = "0.3.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_STORED_STDERR_LINES = 40;
const MAX_TEXT_RESULT_BYTES = DEFAULT_MAX_BYTES;
const XCODE_MCP_ERROR_DETAIL = "xcodeMcpError";
const WORKSPACE_IDENTIFIER_ARGUMENT = "workspaceIdentifier";

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
  workspaceIdentifier: Type.Optional(Type.String({ description: "Optional Xcode workspace identifier. Usually omitted because Pi resolves the workspace matching its current directory automatically." })),
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
        `${piToolName} auto-resolves the matching Xcode workspace and returns the rendered snapshot as an image when Xcode provides previewSnapshotPath.`,
      ];
    case "BuildProject":
      return [`Use ${piToolName} to build the active Xcode scheme when validating Swift or SwiftUI changes.`];
    case "XcodeOpenWorkspace":
      return [`Use ${piToolName} to open the project or workspace matching Pi's current directory when Xcode MCP has no open workspace.`];
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

function structuredContentForDisplay(result: McpCallResult): unknown {
  const textValues = (result.content ?? [])
    .filter((item): item is McpContent & { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text);

  for (const text of textValues) {
    try {
      if (isDeepStrictEqual(JSON.parse(text), result.structuredContent)) return undefined;
    } catch {
      // The text block is not a JSON representation of the structured result.
    }
  }

  if (isObject(result.structuredContent) &&
      typeof result.structuredContent.message === "string" &&
      textValues.includes(result.structuredContent.message)) {
    const { message: _duplicateMessage, ...remainingStructuredContent } = result.structuredContent;
    return Object.keys(remainingStructuredContent).length > 0 ? remainingStructuredContent : undefined;
  }

  return result.structuredContent;
}

export function mcpResultToPiContent(result: McpCallResult): PiContent[] {
  const blocks: PiContent[] = [];

  for (const item of result.content ?? []) {
    blocks.push(...contentBlockToPi(item));
  }

  const structuredContent = structuredContentForDisplay(result);
  if (structuredContent !== undefined) {
    blocks.push({ type: "text", text: truncateForModel(`Structured content:\n${stringify(structuredContent)}`) });
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

function findTestCounts(value: unknown): JsonObject | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const counts = findTestCounts(item);
      if (counts) return counts;
    }
    return undefined;
  }

  if (!isObject(value)) return undefined;
  if (isObject(value.counts) && typeof value.counts.total === "number") return value.counts;

  for (const child of Object.values(value)) {
    const counts = findTestCounts(child);
    if (counts) return counts;
  }

  return undefined;
}

export function resultIndicatesTestFailure(result: McpCallResult): boolean {
  if (result.isError) return true;

  const counts = findTestCounts(result.structuredContent);
  if (counts) {
    const failed = typeof counts.failed === "number" ? counts.failed : 0;
    const total = typeof counts.total === "number" ? counts.total : 0;
    const notRun = typeof counts.notRun === "number" ? counts.notRun : 0;
    if (failed > 0 || (total > 0 && notRun === total)) return true;
  }

  return /\btests? failed\b|\btest run failed\b/i.test(mcpResultText(result));
}

function testResultIsInconclusive(result: McpCallResult): boolean {
  const counts = findTestCounts(result.structuredContent);
  if (!counts) return false;

  const total = typeof counts.total === "number" ? counts.total : 0;
  const notRun = typeof counts.notRun === "number" ? counts.notRun : 0;
  return total > 0 && notRun === total;
}

function resultIndicatesToolFailure(mcpToolName: string, result: McpCallResult): boolean {
  if (mcpToolName === "BuildProject") return resultIndicatesBuildFailure(result);
  if (mcpToolName === "RunAllTests" || mcpToolName === "RunSomeTests") return resultIndicatesTestFailure(result);
  if (mcpToolName === "RenderPreview") return previewResultIndicatesFailure(result);
  return Boolean(result.isError);
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

function schemaHasArgument(schema: unknown, argumentName: string): boolean {
  return isObject(schema) && isObject(schema.properties) && argumentName in schema.properties;
}

function piInputSchemaWithAutoResolvedWorkspace(schema: unknown): unknown {
  if (!isObject(schema)) return schema;

  const required = Array.isArray(schema.required)
    ? schema.required.filter((item) => item !== WORKSPACE_IDENTIFIER_ARGUMENT)
    : [];
  return {
    ...schema,
    required,
  };
}

export function mcpArgumentValidationError(schema: unknown, args: JsonObject): string | undefined {
  if (!isObject(schema)) return undefined;

  const modelFacingSchema = piInputSchemaWithAutoResolvedWorkspace(schema);
  if (!isObject(modelFacingSchema)) return undefined;

  const strictSchema = schemaToTypeBox({ ...modelFacingSchema, additionalProperties: false });
  const errors = Array.from(Value.Errors(strictSchema, args));
  if (errors.length === 0) return undefined;

  return errors.map((error) => {
    if (error.keyword === "additionalProperties" && Array.isArray(error.params?.additionalProperties)) {
      return `unsupported argument(s): ${error.params.additionalProperties.join(", ")}`;
    }
    const location = typeof error.instancePath === "string" && error.instancePath ? error.instancePath : "arguments";
    return `${location} ${error.message}`;
  }).join("; ");
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

function extractWorkspacesFromValue(value: unknown, workspaces: XcodeWorkspace[]): void {
  if (Array.isArray(value)) {
    for (const item of value) extractWorkspacesFromValue(item, workspaces);
    return;
  }

  if (!isObject(value)) return;

  if (typeof value.workspaceIdentifier === "string") {
    workspaces.push({
      workspaceIdentifier: value.workspaceIdentifier,
      workspacePath: typeof value.workspacePath === "string" ? value.workspacePath : undefined,
    });
  }

  for (const child of Object.values(value)) {
    extractWorkspacesFromValue(child, workspaces);
  }
}

export function parseXcodeWorkspaces(result: McpCallResult): XcodeWorkspace[] {
  const workspaces: XcodeWorkspace[] = [];
  extractWorkspacesFromValue(result.structuredContent, workspaces);

  for (const text of collectStringsFromMcpResult(result)) {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/workspaceIdentifier:\s*([^,\s]+)(?:,\s*workspacePath:\s*(.+))?/);
      if (match) {
        workspaces.push({ workspaceIdentifier: match[1], workspacePath: match[2]?.trim() });
      }
    }
  }

  const byIdentifier = new Map<string, XcodeWorkspace>();
  for (const workspace of workspaces) {
    const existing = byIdentifier.get(workspace.workspaceIdentifier);
    byIdentifier.set(workspace.workspaceIdentifier, {
      workspaceIdentifier: workspace.workspaceIdentifier,
      workspacePath: existing?.workspacePath ?? workspace.workspacePath,
    });
  }

  return Array.from(byIdentifier.values());
}

function xcodeWorkspaceRoot(workspacePath: string): string {
  const absolute = resolve(workspacePath);
  return absolute.endsWith(".xcodeproj") || absolute.endsWith(".xcworkspace") ? dirname(absolute) : absolute;
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function scoreWorkspacePathForCwd(workspacePath: string | undefined, cwd: string): number {
  if (!workspacePath) return 0;

  const absoluteCwd = resolve(cwd);
  const absoluteWorkspacePath = resolve(workspacePath);
  const workspaceRoot = xcodeWorkspaceRoot(workspacePath);

  if (absoluteWorkspacePath === absoluteCwd) return 5;
  if (workspaceRoot === absoluteCwd) return 4;
  if (pathContains(workspaceRoot, absoluteCwd)) return 3;
  if (pathContains(absoluteCwd, workspaceRoot)) return 2;

  return 0;
}

function preferredWorkspaceForSamePath(workspaces: XcodeWorkspace[]): XcodeWorkspace | undefined {
  if (workspaces.length === 1) return workspaces[0];

  const paths = new Set(workspaces.map((workspace) => workspace.workspacePath ? resolve(workspace.workspacePath) : undefined));
  if (paths.size !== 1 || paths.has(undefined)) return undefined;

  const headlessWorkspaces = workspaces.filter((workspace) => workspace.workspaceIdentifier.startsWith("workspace-"));
  return headlessWorkspaces.length === 1 ? headlessWorkspaces[0] : undefined;
}

export function selectXcodeWorkspace(workspaces: XcodeWorkspace[], cwd: string): XcodeWorkspace | undefined {
  if (workspaces.length === 0) return undefined;

  const scored = workspaces.map((workspace) => ({ workspace, score: scoreWorkspacePathForCwd(workspace.workspacePath, cwd) }));
  const bestScore = Math.max(...scored.map((item) => item.score));
  const candidates = bestScore > 0
    ? scored.filter((item) => item.score === bestScore).map((item) => item.workspace)
    : workspaces;

  return preferredWorkspaceForSamePath(candidates);
}

function formatXcodeWorkspaces(workspaces: XcodeWorkspace[]): string {
  return workspaces
    .map((workspace) => `- ${workspace.workspaceIdentifier}${workspace.workspacePath ? ` — ${workspace.workspacePath}` : ""}`)
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
  let knownWorkspaces: XcodeWorkspace[] = [];

  const registeredPiToolNames = new Set<string>();
  const toolInfoByPiName = new Map<string, RegisteredToolInfo>();
  const toolInfoByMcpName = new Map<string, RegisteredToolInfo>();

  async function headlessMcpServerState(): Promise<HeadlessMcpServerState> {
    const result = await pi.exec("xcrun", ["mcp-server", "status"], { timeout: 3_000 });
    if (result.code !== 0) return "unavailable";

    const output = `${result.stdout}\n${result.stderr}`;
    if (/^mcp-server:\s*running\s*$/im.test(output)) return "running";
    if (/^Permission:\s*disabled\s*$/im.test(output)) return "disabled";
    return "stopped";
  }

  function setStatus(ctx: { ui: UiLike } | undefined, value: string | undefined): void {
    ctx?.ui.setStatus(STATUS_KEY, value);
  }

  function toolLines(includeArguments = false): string[] {
    if (toolInfoByPiName.size === 0) return ["No Xcode MCP tools discovered yet."];

    return Array.from(toolInfoByPiName.values())
      .sort((a, b) => a.piToolName.localeCompare(b.piToolName))
      .map((tool) => {
        if (!includeArguments || !isObject(tool.inputSchema) || !isObject(tool.inputSchema.properties)) {
          return `${tool.piToolName} → ${tool.mcpToolName}`;
        }

        const required = new Set(Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []);
        const argumentsSummary = Object.keys(tool.inputSchema.properties).map((name) => {
          if (name === WORKSPACE_IDENTIFIER_ARGUMENT) return `${name} (automatic)`;
          return `${name}${required.has(name) ? " (required)" : ""}`;
        }).join(", ");
        return `${tool.piToolName} → ${tool.mcpToolName}${argumentsSummary ? ` — ${argumentsSummary}` : ""}`;
      });
  }

  function resolveMcpToolName(name: string): string {
    if (toolInfoByMcpName.has(name)) return name;
    return toolInfoByPiName.get(name)?.mcpToolName ?? name;
  }

  function findMcpToolName(...candidates: string[]): string | undefined {
    for (const candidate of candidates) {
      if (toolInfoByMcpName.has(candidate)) return candidate;
      const byPiName = toolInfoByPiName.get(candidate) ?? toolInfoByPiName.get(toPiToolName(candidate));
      if (byPiName) return byPiName.mcpToolName;
    }

    return undefined;
  }

  function mcpToolSupportsArgument(mcpToolName: string, argumentName: string): boolean {
    return schemaHasArgument(toolInfoByMcpName.get(mcpToolName)?.inputSchema, argumentName);
  }

  function rememberWorkspaces(result: McpCallResult): void {
    const discovered = parseXcodeWorkspaces(result);
    if (discovered.length === 0) return;

    const byIdentifier = new Map(knownWorkspaces.map((workspace) => [workspace.workspaceIdentifier, workspace]));
    for (const workspace of discovered) {
      const existing = byIdentifier.get(workspace.workspaceIdentifier);
      byIdentifier.set(workspace.workspaceIdentifier, {
        workspaceIdentifier: workspace.workspaceIdentifier,
        workspacePath: workspace.workspacePath ?? existing?.workspacePath,
      });
    }
    knownWorkspaces = Array.from(byIdentifier.values());
  }

  function validateMcpToolArguments(mcpToolName: string, args: JsonObject): void {
    const tool = toolInfoByMcpName.get(mcpToolName);
    if (!tool) {
      throw new Error(`Xcode MCP did not advertise a tool named ${mcpToolName}. Discovered tools:\n${toolLines().join("\n")}`);
    }

    const validationError = mcpArgumentValidationError(tool.inputSchema, args);
    if (!validationError) return;

    const schemaSummary = summarizeSchema(piInputSchemaWithAutoResolvedWorkspace(tool.inputSchema));
    throw new Error(
      `Invalid arguments for Xcode MCP tool ${mcpToolName}: ${validationError}.` +
      `${schemaSummary ? `\nExpected arguments:\n${schemaSummary}` : ""}`,
    );
  }

  async function listXcodeWorkspaces(activeClient: StdioMcpClient, signal?: AbortSignal): Promise<XcodeWorkspace[]> {
    const listWorkspacesToolName = findMcpToolName("XcodeListWorkspaces", "ListWorkspaces");
    if (!listWorkspacesToolName) return knownWorkspaces;

    const result = await activeClient.callTool(listWorkspacesToolName, {}, signal);
    if (result.isError) throw new Error(mcpResultText(result) || "XcodeListWorkspaces failed.");
    knownWorkspaces = parseXcodeWorkspaces(result);
    return knownWorkspaces;
  }

  async function resolveWorkspaceIdentifier(
    activeClient: StdioMcpClient,
    args: JsonObject,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<string> {
    if (typeof args.workspaceIdentifier === "string" && args.workspaceIdentifier.trim()) {
      return args.workspaceIdentifier;
    }

    const workspaces = await listXcodeWorkspaces(activeClient, ctx.signal);
    const selected = selectXcodeWorkspace(workspaces, ctx.cwd);
    if (selected) return selected.workspaceIdentifier;

    if (workspaces.length === 0) {
      throw new Error(
        `Xcode MCP requires workspaceIdentifier, but no workspaces are open. ` +
        `Open the project with xcode_open_workspace using { "path": "/absolute/path/to/project.xcodeproj" } first.`,
      );
    }

    throw new Error(
      `Xcode MCP requires workspaceIdentifier, but Pi could not choose a unique workspace for ${ctx.cwd}. ` +
      `Pass { "workspaceIdentifier": "..." } in tool arguments. Open workspaces:\n${formatXcodeWorkspaces(workspaces)}`,
    );
  }

  async function argumentsWithResolvedWorkspace(
    activeClient: StdioMcpClient,
    mcpToolName: string,
    args: JsonObject,
    ctx: { cwd: string; signal?: AbortSignal },
  ): Promise<JsonObject> {
    validateMcpToolArguments(mcpToolName, args);
    let resolvedArgs = args;

    if (mcpToolSupportsArgument(mcpToolName, WORKSPACE_IDENTIFIER_ARGUMENT) &&
        !(typeof resolvedArgs.workspaceIdentifier === "string" && resolvedArgs.workspaceIdentifier.trim())) {
      resolvedArgs = {
        ...resolvedArgs,
        workspaceIdentifier: await resolveWorkspaceIdentifier(activeClient, resolvedArgs, ctx),
      };
    }

    return resolvedArgs;
  }

  async function disconnect(): Promise<void> {
    const active = client;
    client = undefined;
    knownWorkspaces = [];
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
    const resolvedArgs = await argumentsWithResolvedWorkspace(activeClient, mcpToolName, args, ctx);

    onUpdate?.({
      content: [{ type: "text", text: `Calling Xcode MCP tool: ${mcpToolName}...` }],
      details: { mcpTool: mcpToolName, arguments: resolvedArgs },
    });

    const result = await activeClient.callTool(mcpToolName, resolvedArgs, ctx.signal);
    rememberWorkspaces(result);
    const content = mcpResultToPiContent(result);
    const isPreviewTool = mcpToolName === "RenderPreview";
    if (isPreviewTool) {
      await appendPreviewSnapshotImages(content, result);
    }
    if ((mcpToolName === "RunAllTests" || mcpToolName === "RunSomeTests") && testResultIsInconclusive(result)) {
      content.unshift({
        type: "text",
        text: "Xcode MCP returned no result for every discovered test. Treat this test run as inconclusive; do not retry it with guessed argument shapes.",
      });
    }

    return {
      content,
      details: {
        mcpTool: mcpToolName,
        arguments: resolvedArgs,
        [XCODE_MCP_ERROR_DETAIL]: resultIndicatesToolFailure(mcpToolName, result),
      },
    };
  }

  async function renderPreview(
    params: JsonObject,
    ctx: { ui: UiLike; cwd: string; signal?: AbortSignal },
    onUpdate?: (partial: { content: PiContent[]; details: JsonObject }) => void,
  ) {
    const activeClient = await ensureConnected(ctx);
    const renderPreviewToolName = findMcpToolName("RenderPreview", "XcodeRenderPreview");

    if (!renderPreviewToolName) {
      throw new Error(`Xcode MCP did not advertise a SwiftUI preview render tool. Discovered tools:\n${toolLines().join("\n")}`);
    }

    const renderArgs = await argumentsWithResolvedWorkspace(activeClient, renderPreviewToolName, params, ctx);

    onUpdate?.({
      content: [{ type: "text", text: `Rendering SwiftUI preview through Xcode MCP (${renderPreviewToolName})...` }],
      details: { renderPreviewTool: renderPreviewToolName, arguments: renderArgs },
    });

    const result = await activeClient.callTool(renderPreviewToolName, renderArgs, ctx.signal);
    rememberWorkspaces(result);
    const content = mcpResultToPiContent(result);
    await appendPreviewSnapshotImages(content, result);

    return {
      content,
      details: {
        renderPreviewTool: renderPreviewToolName,
        arguments: renderArgs,
        [XCODE_MCP_ERROR_DETAIL]: previewResultIndicatesFailure(result),
      },
    };
  }

  async function buildWithDiagnostics(
    params: { arguments?: JsonObject; includeBuildLog?: "onFailure" | "always" | "never"; includeNavigatorIssues?: boolean },
    ctx: { ui: UiLike; cwd: string; signal?: AbortSignal },
    onUpdate?: (partial: { content: PiContent[]; details: JsonObject }) => void,
  ) {
    const activeClient = await ensureConnected(ctx);
    const buildToolName = findMcpToolName("BuildProject", "XcodeBuildProject");

    if (!buildToolName) {
      throw new Error(`Xcode MCP did not advertise a build tool. Discovered tools:\n${toolLines().join("\n")}`);
    }

    const buildArgs = await argumentsWithResolvedWorkspace(activeClient, buildToolName, params.arguments ?? {}, ctx);

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
    let diagnosticsFailed = false;
    const details: JsonObject = {
      buildTool: buildToolName,
      buildArguments: buildArgs,
      buildFailed,
    };
    const diagnosticBaseArgs: JsonObject = {};
    if (typeof buildArgs.workspaceIdentifier === "string") diagnosticBaseArgs.workspaceIdentifier = buildArgs.workspaceIdentifier;

    if (shouldFetchBuildLog) {
      const buildLogToolName = findMcpToolName("GetBuildLog", "XcodeGetBuildLog");
      if (buildLogToolName) {
        const buildLogArgs = await argumentsWithResolvedWorkspace(activeClient, buildLogToolName, diagnosticBaseArgs, ctx);

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
        diagnosticsFailed ||= Boolean(buildLogResult.isError);
        details.buildLogTool = buildLogToolName;
        details.buildLogArguments = buildLogArgs;
      } else {
        content.push({ type: "text", text: "## GetBuildLog\n\nXcode MCP did not advertise a GetBuildLog tool." });
      }
    }

    if (buildFailed && includeNavigatorIssues) {
      const navigatorIssuesToolName = findMcpToolName("XcodeListNavigatorIssues", "ListNavigatorIssues");
      if (navigatorIssuesToolName) {
        const navigatorIssuesArgs = await argumentsWithResolvedWorkspace(activeClient, navigatorIssuesToolName, diagnosticBaseArgs, ctx);

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
        diagnosticsFailed ||= Boolean(navigatorIssuesResult.isError);
        details.navigatorIssuesTool = navigatorIssuesToolName;
        details.navigatorIssuesArguments = navigatorIssuesArgs;
      }
    }

    details.diagnosticsFailed = diagnosticsFailed;
    details[XCODE_MCP_ERROR_DETAIL] = buildFailed || diagnosticsFailed;
    return {
      content,
      details,
    };
  }

  function registerMcpTool(tool: McpTool): void {
    const info = { piToolName: toPiToolName(tool.name), mcpToolName: tool.name, inputSchema: tool.inputSchema };
    const piInputSchema = piInputSchemaWithAutoResolvedWorkspace(tool.inputSchema);
    toolInfoByPiName.set(info.piToolName, info);
    toolInfoByMcpName.set(info.mcpToolName, info);

    if (registeredPiToolNames.has(info.piToolName)) return;
    registeredPiToolNames.add(info.piToolName);

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
        content: [{ type: "text", text: `Connected to Xcode MCP. Discovered tools and arguments:\n${toolLines(true).join("\n")}` }],
        details: { tools: Array.from(toolInfoByPiName.values()) },
      };
    },
  });

  registeredPiToolNames.add("xcode_render_preview");
  pi.registerTool({
    name: "xcode_render_preview",
    label: "Render SwiftUI Preview",
    description: "Render a SwiftUI preview through Xcode MCP, auto-resolve the matching Xcode workspace, and attach Xcode's rendered preview snapshot image to the tool result.",
    promptSnippet: "Render a SwiftUI preview screenshot through Xcode MCP",
    promptGuidelines: [
      "Use xcode_render_preview when the user asks to inspect, verify, or iterate on a SwiftUI preview visually.",
      "Use xcode_render_preview after SwiftUI UI changes to capture the rendered preview screenshot before judging visual correctness.",
      "xcode_render_preview auto-resolves the matching Xcode workspace and returns the rendered snapshot as an image when Xcode provides previewSnapshotPath.",
    ],
    parameters: RenderPreviewParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return renderPreview(params, { ui: ctx.ui, cwd: ctx.cwd, signal }, onUpdate);
    },
  });

  pi.registerTool({
    name: "xcode_build",
    label: "Xcode Build",
    description: "Build the active Xcode scheme through Xcode MCP, then automatically fetch Xcode build errors and diagnostics when the build fails. This is usually faster and more project-aware than shelling out to xcodebuild because it uses the active Xcode workspace.",
    promptSnippet: "Build the active Xcode scheme through Xcode MCP and fetch errors on failure",
    promptGuidelines: [
      "Prefer xcode_build over shell xcodebuild when validating Swift, SwiftUI, or Xcode project changes and Xcode MCP is available.",
      "Use xcode_build to build through the active Xcode workspace and automatically retrieve GetBuildLog/Issue Navigator diagnostics on failure.",
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
    description: "Fallback for calling any discovered Xcode MCP tool by name. Arguments are validated against the tool's advertised schema, and Xcode workspace context is resolved automatically. Prefer a specific mirrored xcode_* tool whenever available.",
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

  pi.on("tool_result", (event) => {
    if (!event.toolName.startsWith("xcode_") || !isObject(event.details)) return;
    if (event.details[XCODE_MCP_ERROR_DETAIL] === true) return { isError: true };
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
      const headlessState = await headlessMcpServerState();
      if (headlessState !== "running") {
        const status = headlessState === "disabled"
          ? "xcode mcp: headless disabled"
          : headlessState === "stopped"
            ? "xcode mcp: headless stopped"
            : "xcode mcp: Xcode closed";
        setStatus(ctx, status);
        return;
      }
    }

    try {
      await ensureConnected({ ui: ctx.ui, cwd: ctx.cwd, signal: ctx.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(ctx, "xcode mcp: offline");
      ctx.ui.notify(
        `Xcode MCP is offline. Open Xcode with a project, or enable and start Xcode 27's headless MCP service, then run /xcode-mcp-connect. (${message})`,
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
