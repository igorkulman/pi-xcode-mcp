import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type JsonObject = Record<string, unknown>;

type McpContent =
  | { type: "text"; text?: unknown; [key: string]: unknown }
  | { type: "image"; data?: unknown; mimeType?: unknown; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

type McpCallResult = {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

type PiContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type NestedToolResult = {
  content: PiContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

type NestedToolOutcome = {
  result: NestedToolResult;
  isError: boolean;
};

type CallableTool = {
  name: string;
  parameters?: unknown;
};

type ToolContext = {
  cwd: string;
  signal?: AbortSignal;
  tools: readonly CallableTool[];
  executeTool(
    name: string,
    args: unknown,
    options?: {
      signal?: AbortSignal;
      onUpdate?: (result: NestedToolResult) => void;
    },
  ): Promise<NestedToolOutcome>;
};

type ToolUpdate = (partial: { content: PiContent[]; details: JsonObject }) => void;

type NativeMcpCall = {
  mcpToolName: string;
  piToolName: string;
  arguments: JsonObject;
  protocolResult: McpCallResult;
  content: PiContent[];
  isError: boolean;
};

export type XcodeWorkspace = {
  workspaceIdentifier: string;
  workspacePath?: string;
};

const MCP_SERVER_NAME = "xcode";
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const MCP_TIMEOUT_SECONDS = 120;
const XCODE_MCP_ERROR_DETAIL = "xcodeMcpError";
const WORKSPACE_IDENTIFIER_ARGUMENT = "workspaceIdentifier";

const BaseMcpCallParams = Type.Object({
  name: Type.String({
    description: "Xcode MCP tool name, e.g. RenderPreview, BuildProject, or mcp__xcode__DocumentationSearch.",
  }),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    description: "Arguments to pass to the native Xcode MCP tool.",
  })),
});

const BuildWithDiagnosticsParams = Type.Object({
  arguments: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    description: "Optional arguments forwarded to Xcode MCP BuildProject.",
  })),
  includeBuildLog: Type.Optional(Type.Union([
    Type.Literal("onFailure"),
    Type.Literal("always"),
    Type.Literal("never"),
  ], { description: "When to fetch Xcode MCP GetBuildLog after building. Defaults to onFailure." })),
  includeNavigatorIssues: Type.Optional(Type.Boolean({
    description: "Also fetch Xcode Issue Navigator diagnostics after a failed build. Defaults to true.",
  })),
});

const RenderPreviewParams = Type.Object({
  sourceFilePath: Type.String({
    description: "Path to the SwiftUI source file within the Xcode project organization, e.g. ProjectName/Sources/MyView.swift.",
  }),
  previewDefinitionIndexInFile: Type.Optional(Type.Integer({
    description: "Zero-based index of the #Preview macro or PreviewProvider in the source file. Defaults to 0.",
  })),
  previewVariantOverrides: Type.Optional(Type.Record(Type.String(), Type.Any(), {
    description: "Optional preview variant overrides returned by a previous render for the same scheme/destination.",
  })),
  timeout: Type.Optional(Type.Integer({
    description: "Seconds to wait for preview rendering. Defaults to Xcode MCP's timeout.",
  })),
  workspaceIdentifier: Type.Optional(Type.String({
    description: "Optional Xcode workspace identifier. Usually omitted because Pi resolves the workspace matching its current directory.",
  })),
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

function nativePiToolName(mcpToolName: string): string {
  return `${MCP_TOOL_PREFIX}${mcpToolName}`;
}

function mcpToolNameFromPiName(piToolName: string): string | undefined {
  return piToolName.startsWith(MCP_TOOL_PREFIX) ? piToolName.slice(MCP_TOOL_PREFIX.length) : undefined;
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

function legacyPiToolName(mcpToolName: string): string {
  const normalized = toSnakeCase(stripLeadingXcode(mcpToolName));
  return normalized.startsWith("xcode_") ? normalized : `xcode_${normalized}`;
}

function findNativeMcpTool(ctx: ToolContext, requestedName: string): { piToolName: string; mcpToolName: string; parameters?: unknown } | undefined {
  const exactPiName = requestedName.startsWith(MCP_TOOL_PREFIX)
    ? requestedName
    : nativePiToolName(requestedName);
  const exact = ctx.tools.find((tool) => tool.name === exactPiName);
  if (exact) {
    return {
      piToolName: exact.name,
      mcpToolName: mcpToolNameFromPiName(exact.name) ?? requestedName,
      parameters: exact.parameters,
    };
  }

  for (const tool of ctx.tools) {
    const mcpToolName = mcpToolNameFromPiName(tool.name);
    if (mcpToolName && legacyPiToolName(mcpToolName) === requestedName) {
      return { piToolName: tool.name, mcpToolName, parameters: tool.parameters };
    }
  }

  return undefined;
}

function mcpResultFromNestedResult(result: NestedToolResult, isError: boolean): McpCallResult {
  if (isObject(result.structuredContent) && Array.isArray(result.structuredContent.content)) {
    return result.structuredContent as McpCallResult;
  }

  return {
    content: result.content.map((block) => ({ ...block })),
    isError: isError || result.isError,
  };
}

async function callNativeMcpTool(
  ctx: ToolContext,
  requestedName: string,
  args: JsonObject,
  onUpdate?: ToolUpdate,
): Promise<NativeMcpCall> {
  const tool = findNativeMcpTool(ctx, requestedName);
  if (!tool) {
    const available = ctx.tools
      .map((candidate) => mcpToolNameFromPiName(candidate.name))
      .filter((name): name is string => Boolean(name))
      .sort();
    throw new Error(
      `Xcode MCP tool ${requestedName} is unavailable. Check /mcp and reconnect the xcode server.` +
      `${available.length > 0 ? ` Available Xcode MCP tools: ${available.join(", ")}` : " No Xcode MCP tools are connected."}`,
    );
  }

  onUpdate?.({
    content: [{ type: "text", text: `Calling native Xcode MCP tool: ${tool.mcpToolName}...` }],
    details: { mcpTool: tool.mcpToolName, arguments: args },
  });

  const outcome = await ctx.executeTool(tool.piToolName, args, {
    signal: ctx.signal,
    onUpdate: (partial) => {
      onUpdate?.({
        content: partial.content,
        details: { mcpTool: tool.mcpToolName, arguments: args },
      });
    },
  });
  const protocolResult = mcpResultFromNestedResult(outcome.result, outcome.isError);

  return {
    mcpToolName: tool.mcpToolName,
    piToolName: tool.piToolName,
    arguments: args,
    protocolResult,
    content: outcome.result.content,
    isError: outcome.isError || outcome.result.isError === true || protocolResult.isError === true,
  };
}

function schemaHasArgument(schema: unknown, argumentName: string): boolean {
  return isObject(schema) && isObject(schema.properties) && argumentName in schema.properties;
}

function collectStringsFromMcpResult(result: McpCallResult): string[] {
  const strings: string[] = [];

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      strings.push(value);
      try {
        visit(JSON.parse(value));
      } catch {
        // The original string is still useful for the text fallback parsers.
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
  return absolute.endsWith(".xcodeproj") || absolute.endsWith(".xcworkspace")
    ? resolve(absolute, "..")
    : absolute;
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

  const scored = workspaces.map((workspace) => ({
    workspace,
    score: scoreWorkspacePathForCwd(workspace.workspacePath, cwd),
  }));
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

async function resolveWorkspaceIdentifier(
  ctx: ToolContext,
  explicitIdentifier: unknown,
  onUpdate?: ToolUpdate,
): Promise<string> {
  if (typeof explicitIdentifier === "string" && explicitIdentifier.trim()) {
    return explicitIdentifier;
  }

  const listCall = await callNativeMcpTool(ctx, "XcodeListWorkspaces", {}, onUpdate);
  if (listCall.isError) {
    throw new Error(`XcodeListWorkspaces failed: ${textFromContent(listCall.content) || "unknown Xcode MCP error"}`);
  }

  const workspaces = parseXcodeWorkspaces(listCall.protocolResult);
  const selected = selectXcodeWorkspace(workspaces, ctx.cwd);
  if (selected) return selected.workspaceIdentifier;

  if (workspaces.length === 0) {
    throw new Error(
      "Xcode MCP requires workspaceIdentifier, but no workspaces are open. " +
      "Use the native XcodeOpenWorkspace MCP tool to open the project first.",
    );
  }

  throw new Error(
    `Xcode MCP requires workspaceIdentifier, but Pi could not choose a unique workspace for ${ctx.cwd}. ` +
    `Pass workspaceIdentifier explicitly. Open workspaces:\n${formatXcodeWorkspaces(workspaces)}`,
  );
}

async function argumentsWithResolvedWorkspace(
  ctx: ToolContext,
  requestedName: string,
  args: JsonObject,
  onUpdate?: ToolUpdate,
): Promise<JsonObject> {
  const tool = findNativeMcpTool(ctx, requestedName);
  if (!tool || !schemaHasArgument(tool.parameters, WORKSPACE_IDENTIFIER_ARGUMENT)) return args;
  if (typeof args.workspaceIdentifier === "string" && args.workspaceIdentifier.trim()) return args;

  return {
    ...args,
    workspaceIdentifier: await resolveWorkspaceIdentifier(ctx, args.workspaceIdentifier, onUpdate),
  };
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
      content.push({
        type: "text",
        text: `SwiftUI preview snapshot was rendered at ${path}, but Pi could not read it: ${message}`,
      });
    }
  }
}

function textFromContent(content: PiContent[]): string {
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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

  if (result.structuredContent !== undefined) parts.push(stringify(result.structuredContent));
  return parts.join("\n");
}

function structuredContentIndicatesFailure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(structuredContentIndicatesFailure);
  if (!isObject(value)) return false;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (typeof child === "boolean" && child === false && ["success", "succeeded", "buildsucceeded", "passed"].includes(normalizedKey)) {
      return true;
    }
    if (typeof child === "string" && /(status|state|result|outcome)/i.test(key) && /\b(failed|failure|error)\b/i.test(child)) {
      return true;
    }
    if (structuredContentIndicatesFailure(child)) return true;
  }

  return false;
}

export function resultIndicatesBuildFailure(result: McpCallResult): boolean {
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

function resultIndicatesToolFailure(mcpToolName: string, result: McpCallResult): boolean {
  if (mcpToolName === "BuildProject") return resultIndicatesBuildFailure(result);
  if (mcpToolName === "RunAllTests" || mcpToolName === "RunSomeTests") return resultIndicatesTestFailure(result);
  if (mcpToolName === "RenderPreview") return previewResultIndicatesFailure(result);
  return result.isError === true;
}

function toolContextWithSignal(ctx: ToolContext, signal: AbortSignal | undefined): ToolContext {
  return {
    cwd: ctx.cwd,
    signal,
    tools: ctx.tools,
    executeTool: ctx.executeTool.bind(ctx),
  };
}

function sectionedContent(title: string, call: NativeMcpCall): PiContent[] {
  const blocks = call.content.map((block) => ({ ...block })) as PiContent[];
  const firstText = blocks.find((block): block is { type: "text"; text: string } => block.type === "text");
  if (firstText) {
    firstText.text = `## ${title}\n\n${firstText.text}`;
  } else {
    blocks.unshift({ type: "text", text: `## ${title}` });
  }
  return blocks;
}

async function renderPreview(
  params: JsonObject,
  ctx: ToolContext,
  onUpdate?: ToolUpdate,
) {
  const renderArgs = await argumentsWithResolvedWorkspace(ctx, "RenderPreview", params, onUpdate);
  const call = await callNativeMcpTool(ctx, "RenderPreview", renderArgs, onUpdate);
  const content = [...call.content];
  await appendPreviewSnapshotImages(content, call.protocolResult);
  const failed = call.isError || previewResultIndicatesFailure(call.protocolResult);

  return {
    content,
    details: {
      mcpTool: call.mcpToolName,
      arguments: call.arguments,
      [XCODE_MCP_ERROR_DETAIL]: failed,
    },
    ...(failed ? { isError: true } : {}),
  };
}

async function buildWithDiagnostics(
  params: {
    arguments?: JsonObject;
    includeBuildLog?: "onFailure" | "always" | "never";
    includeNavigatorIssues?: boolean;
  },
  ctx: ToolContext,
  onUpdate?: ToolUpdate,
) {
  const buildArgs = await argumentsWithResolvedWorkspace(ctx, "BuildProject", params.arguments ?? {}, onUpdate);
  const buildCall = await callNativeMcpTool(ctx, "BuildProject", buildArgs, onUpdate);
  const buildFailed = buildCall.isError || resultIndicatesBuildFailure(buildCall.protocolResult);
  const includeBuildLog = params.includeBuildLog ?? "onFailure";
  const includeNavigatorIssues = params.includeNavigatorIssues ?? true;
  const shouldFetchBuildLog = includeBuildLog === "always" || (includeBuildLog === "onFailure" && buildFailed);
  const content: PiContent[] = [
    {
      type: "text",
      text: buildFailed
        ? "Xcode MCP build reported a failure. Available Xcode diagnostics follow."
        : "Xcode MCP build completed without detected build errors.",
    },
    ...sectionedContent("BuildProject", buildCall),
  ];
  const details: JsonObject = {
    buildTool: buildCall.mcpToolName,
    buildArguments: buildArgs,
    buildFailed,
  };
  let diagnosticsFailed = false;
  const diagnosticBaseArgs: JsonObject = {};
  if (typeof buildArgs.workspaceIdentifier === "string") {
    diagnosticBaseArgs.workspaceIdentifier = buildArgs.workspaceIdentifier;
  }

  if (shouldFetchBuildLog && findNativeMcpTool(ctx, "GetBuildLog")) {
    const logArgs = await argumentsWithResolvedWorkspace(ctx, "GetBuildLog", diagnosticBaseArgs, onUpdate);
    const logCall = await callNativeMcpTool(ctx, "GetBuildLog", logArgs, onUpdate);
    content.push(...sectionedContent("GetBuildLog", logCall));
    diagnosticsFailed ||= logCall.isError;
    details.buildLogTool = logCall.mcpToolName;
    details.buildLogArguments = logArgs;
  }

  if (buildFailed && includeNavigatorIssues && findNativeMcpTool(ctx, "XcodeListNavigatorIssues")) {
    const issuesArgs = await argumentsWithResolvedWorkspace(ctx, "XcodeListNavigatorIssues", diagnosticBaseArgs, onUpdate);
    const issuesCall = await callNativeMcpTool(ctx, "XcodeListNavigatorIssues", issuesArgs, onUpdate);
    content.push(...sectionedContent("Issue Navigator", issuesCall));
    diagnosticsFailed ||= issuesCall.isError;
    details.navigatorIssuesTool = issuesCall.mcpToolName;
    details.navigatorIssuesArguments = issuesArgs;
  }

  const failed = buildFailed || diagnosticsFailed;
  details.diagnosticsFailed = diagnosticsFailed;
  details[XCODE_MCP_ERROR_DETAIL] = failed;

  return {
    content,
    details,
    ...(failed ? { isError: true } : {}),
  };
}

export default function xcodeMcpExtension(pi: ExtensionAPI) {
  pi.registerMcpServer(MCP_SERVER_NAME, {
    command: "xcrun",
    args: ["mcpbridge"],
    exposure: "codemode",
    timeout: MCP_TIMEOUT_SECONDS,
  });

  pi.registerTool({
    name: "xcode_render_preview",
    label: "Render SwiftUI Preview",
    description: "Render a SwiftUI preview through Pi's native Xcode MCP connection, auto-resolve the matching workspace, and attach Xcode's preview snapshot image.",
    promptSnippet: "Render a SwiftUI preview screenshot through native Xcode MCP",
    promptGuidelines: [
      "Use xcode_render_preview when the user asks to inspect, verify, or iterate on a SwiftUI preview visually.",
      "Use xcode_render_preview after SwiftUI UI changes before judging visual correctness.",
      "xcode_render_preview resolves the matching workspace and attaches the previewSnapshotPath image automatically.",
    ],
    parameters: RenderPreviewParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return renderPreview(params, toolContextWithSignal(ctx, signal), onUpdate as ToolUpdate | undefined);
    },
  });

  pi.registerTool({
    name: "xcode_build",
    label: "Xcode Build",
    description: "Build the active scheme through Pi's native Xcode MCP connection and automatically fetch build logs and Issue Navigator diagnostics on failure.",
    promptSnippet: "Build through native Xcode MCP and fetch diagnostics on failure",
    promptGuidelines: [
      "Prefer xcode_build over shell xcodebuild when Xcode MCP is available.",
      "Use xcode_build to build the matching Xcode workspace and retrieve diagnostics automatically.",
      "Only fall back to shell xcodebuild when Xcode MCP is unavailable or does not expose the required operation.",
    ],
    parameters: BuildWithDiagnosticsParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return buildWithDiagnostics(params, toolContextWithSignal(ctx, signal), onUpdate as ToolUpdate | undefined);
    },
  });

  pi.registerTool({
    name: "xcode_mcp_call",
    label: "Xcode MCP Call",
    description: "Fallback wrapper for a native Xcode MCP tool. Accepts the MCP name, native Pi name, or legacy xcode_* alias and resolves workspace context when required.",
    promptSnippet: "Call an arbitrary native Xcode MCP tool",
    promptGuidelines: [
      "Use xcode_mcp_call only when xcode_render_preview, xcode_build, or a native Xcode MCP tool through codemode is not more appropriate.",
    ],
    parameters: BaseMcpCallParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const toolCtx = toolContextWithSignal(ctx, signal);
      const args = await argumentsWithResolvedWorkspace(toolCtx, params.name, (params.arguments ?? {}) as JsonObject, onUpdate as ToolUpdate | undefined);
      const call = await callNativeMcpTool(toolCtx, params.name, args, onUpdate as ToolUpdate | undefined);
      const content = [...call.content];
      if (call.mcpToolName === "RenderPreview") {
        await appendPreviewSnapshotImages(content, call.protocolResult);
      }
      const failed = call.isError || resultIndicatesToolFailure(call.mcpToolName, call.protocolResult);
      return {
        content,
        details: {
          mcpTool: call.mcpToolName,
          arguments: call.arguments,
          [XCODE_MCP_ERROR_DETAIL]: failed,
        },
        ...(failed ? { isError: true } : {}),
      };
    },
  });

  pi.on("tool_result", (event) => {
    const mcpToolName = mcpToolNameFromPiName(event.toolName);
    if (mcpToolName) {
      const result = mcpResultFromNestedResult({
        content: event.content as PiContent[],
        structuredContent: event.structuredContent,
        isError: event.isError,
      }, event.isError);
      if (resultIndicatesToolFailure(mcpToolName, result)) return { isError: true };
      return;
    }

    if (event.toolName.startsWith("xcode_") && isObject(event.details) && event.details[XCODE_MCP_ERROR_DETAIL] === true) {
      return { isError: true };
    }
  });
}
