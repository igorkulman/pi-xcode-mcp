import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";

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

const WorkspaceParam = Type.Optional(Type.String({
  description: "Workspace identifier or .xcodeproj/.xcworkspace path. By default, reuse or open the project matching the current directory.",
}));
const SchemeParam = Type.Optional(Type.String({
  description: "Scheme to select and verify before and after the operation. If omitted, check that the active scheme does not change.",
}));

const BuildWithDiagnosticsParams = Type.Object({
  workspaceIdentifier: WorkspaceParam,
  schemeName: SchemeParam,
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

const TestParams = Type.Object({
  workspaceIdentifier: WorkspaceParam,
  schemeName: SchemeParam,
  testPlanName: Type.Optional(Type.String({ description: "Test plan to select and verify for this run." })),
  tests: Type.Optional(Type.Array(Type.Object({
    targetName: Type.String(),
    testIdentifier: Type.String(),
  }), { minItems: 1, description: "Tests discovered with GetTestList. Omit to run the active test plan." })),
});

const RenderPreviewParams = Type.Object({
  schemeName: SchemeParam,
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
  workspaceIdentifier: WorkspaceParam,
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
    structuredContent: result.structuredContent,
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
    try { extractWorkspacesFromValue(JSON.parse(text), workspaces); } catch { /* Also accept Xcode's plain text listing. */ }
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
  if (bestScore === 0) return undefined;
  const candidates = scored.filter((item) => item.score === bestScore).map((item) => item.workspace);
  return preferredWorkspaceForSamePath(candidates);
}

function formatXcodeWorkspaces(workspaces: XcodeWorkspace[]): string {
  return workspaces
    .map((workspace) => `- ${workspace.workspaceIdentifier}${workspace.workspacePath ? ` — ${workspace.workspacePath}` : ""}`)
    .join("\n");
}

export async function discoverXcodeWorkspace(cwd: string): Promise<string | undefined> {
  let directory = resolve(cwd);
  if (/\.(xcodeproj|xcworkspace)$/.test(directory)) return directory;

  while (true) {
    const entries = await readdir(directory, { withFileTypes: true });
    const workspaces = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace"));
    const projects = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
    const candidates = workspaces.length > 0 ? workspaces : projects;
    if (candidates.length === 1) return join(directory, candidates[0].name);
    if (candidates.length > 1) {
      throw new Error(`Multiple Xcode projects/workspaces in ${directory}. Pass workspaceIdentifier with the desired project path.`);
    }
    // Do not escape a repository/worktree to open a neighbouring project.
    if (entries.some((entry) => entry.name === ".git") || dirname(directory) === directory) return undefined;
    directory = dirname(directory);
  }
}

async function openXcodeWorkspace(ctx: ToolContext, path: string, onUpdate?: ToolUpdate): Promise<string> {
  const call = await callNativeMcpTool(ctx, "XcodeOpenWorkspace", { path }, onUpdate);
  if (call.isError) throw new Error(`Could not open ${path}: ${mcpResultText(call.protocolResult)}`);
  const workspace = parseXcodeWorkspaces(call.protocolResult).find((item) =>
    item.workspacePath === undefined || resolve(item.workspacePath) === resolve(path));
  if (!workspace) throw new Error(`XcodeOpenWorkspace did not return a workspace identifier for ${path}.`);
  return workspace.workspaceIdentifier;
}

async function resolveWorkspaceIdentifier(
  ctx: ToolContext,
  explicitIdentifier: unknown,
  onUpdate?: ToolUpdate,
): Promise<string> {
  const explicit = typeof explicitIdentifier === "string" ? explicitIdentifier.trim() : undefined;
  const explicitPath = explicit && /\.(xcodeproj|xcworkspace)$/.test(explicit) ? resolve(ctx.cwd, explicit) : undefined;
  if (explicit && !explicitPath) return explicit;

  const listCall = await callNativeMcpTool(ctx, "XcodeListWorkspaces", {}, onUpdate);
  if (listCall.isError) {
    throw new Error(`XcodeListWorkspaces failed: ${textFromContent(listCall.content) || "unknown Xcode MCP error"}`);
  }

  const workspaces = parseXcodeWorkspaces(listCall.protocolResult);
  const selected = explicitPath
    ? preferredWorkspaceForSamePath(workspaces.filter((item) => item.workspacePath && resolve(item.workspacePath) === explicitPath))
    : selectXcodeWorkspace(workspaces, ctx.cwd);
  if (selected) return selected.workspaceIdentifier;

  const path = explicitPath ?? await discoverXcodeWorkspace(ctx.cwd);
  if (path) return openXcodeWorkspace(ctx, path, onUpdate);

  throw new Error(
    `No matching Xcode workspace or unambiguous local project was found for ${ctx.cwd}. ` +
    `Pass workspaceIdentifier explicitly (an identifier or .xcodeproj/.xcworkspace path). ` +
    `The headless MCP service must already be running. Open workspaces:\n${formatXcodeWorkspaces(workspaces)}`,
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

function resultData(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const item of result.content ?? []) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try { return JSON.parse(item.text); } catch { /* Plain text is handled separately. */ }
  }
  return undefined;
}

function structuredContentIndicatesFailure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(structuredContentIndicatesFailure);
  if (!isObject(value)) return false;

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (typeof child === "boolean" && child === false && ["success", "succeeded", "buildsucceeded", "passed"].includes(normalizedKey)) {
      return true;
    }
    if (typeof child === "string" && /(status|state|result|outcome)/i.test(key) && /\b(failed|failure|error|cancelled|canceled|aborted)\b/i.test(child)) {
      return true;
    }
    if (structuredContentIndicatesFailure(child)) return true;
  }

  return false;
}

function operationStatusText(result: McpCallResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try { JSON.parse(item.text); } catch { parts.push(item.text); }
  }
  const data = resultData(result);
  if (isObject(data)) {
    for (const key of ["buildResult", "summary", "status", "result", "outcome", "error", "message", "data"]) {
      if (typeof data[key] === "string") parts.push(data[key]);
    }
  }
  return parts.join("\n");
}

function resultIndicatesCancellation(result: McpCallResult): boolean {
  const cancelled = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(cancelled);
    if (!isObject(value)) return false;
    return Object.entries(value).some(([key, child]) =>
      (typeof child === "string" && /(status|state|result|outcome)/i.test(key) && /\b(cancelled|canceled|aborted)\b/i.test(child)) || cancelled(child));
  };
  return cancelled(resultData(result)) ||
    /\b(build(?: action)?|test(?: run)?|operation|request) (?:was |is )?(cancelled|canceled|aborted)\b|\b(cancelled|canceled|aborted) (build|test run)\b|^(cancelled|canceled|aborted)$/im.test(operationStatusText(result));
}

export function resultIndicatesBuildFailure(result: McpCallResult): boolean {
  if (result.isError || resultIndicatesCancellation(result)) return true;
  if (structuredContentIndicatesFailure(resultData(result))) return true;
  return /\b(build failed|build action failed|failed to build|compilation failed|compile failed|link failed|fatal error:)\b|\berror:/i.test(operationStatusText(result));
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
  if (result.isError || resultIndicatesCancellation(result)) return true;

  const counts = findTestCounts(resultData(result));
  if (counts) {
    const failed = typeof counts.failed === "number" ? counts.failed : 0;
    const total = typeof counts.total === "number" ? counts.total : 0;
    const notRun = typeof counts.notRun === "number" ? counts.notRun : 0;
    if (failed > 0 || total === 0 || notRun > 0) return true;
  }

  return /\btests? failed\b|\btest run failed\b|\bbuild action failed\b|\bno tests (ran|were run)\b/i.test(operationStatusText(result));
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

  return hasErrorsField(resultData(result));
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

type WorkflowContext = { workspaceIdentifier?: string; schemeName?: string; testPlanName?: string };

async function activeWorkflowContext(ctx: ToolContext, workspaceIdentifier: string | undefined): Promise<WorkflowContext> {
  const context: WorkflowContext = { workspaceIdentifier };
  const args = workspaceIdentifier ? { workspaceIdentifier } : {};
  if (findNativeMcpTool(ctx, "XcodeListSchemes")) {
    const call = await callNativeMcpTool(ctx, "XcodeListSchemes", args);
    if (call.isError) throw new Error(`Cannot check the active scheme: ${mcpResultText(call.protocolResult)}`);
    const data = resultData(call.protocolResult);
    if (isObject(data) && typeof data.activeSchemeName === "string") context.schemeName = data.activeSchemeName;
  }
  if (findNativeMcpTool(ctx, "XcodeListTestPlans")) {
    const call = await callNativeMcpTool(ctx, "XcodeListTestPlans", args);
    if (call.isError) throw new Error(`Cannot check the active test plan: ${mcpResultText(call.protocolResult)}`);
    const data = resultData(call.protocolResult);
    if (isObject(data) && typeof data.activeTestPlanName === "string") context.testPlanName = data.activeTestPlanName;
  }
  return context;
}

async function prepareWorkflow(
  ctx: ToolContext,
  workspaceIdentifier: string | undefined,
  schemeName?: string,
  testPlanName?: string,
): Promise<WorkflowContext> {
  const args = workspaceIdentifier ? { workspaceIdentifier } : {};
  for (const [name, field, value] of [
    ["XcodeSwitchScheme", "schemeName", schemeName],
    ["XcodeSwitchTestPlan", "testPlanName", testPlanName],
  ] as const) {
    if (!value) continue;
    const call = await callNativeMcpTool(ctx, name, { ...args, [field]: value });
    if (call.isError) throw new Error(`${name} failed: ${mcpResultText(call.protocolResult)}`);
  }
  const context = await activeWorkflowContext(ctx, workspaceIdentifier);
  if (schemeName && context.schemeName !== schemeName) throw new Error(`Xcode did not select scheme '${schemeName}' (active: ${context.schemeName ?? "unknown"}).`);
  const expectedPlan = testPlanName && basename(testPlanName).replace(/\.xctestplan$/, "");
  if (expectedPlan && context.testPlanName !== expectedPlan) throw new Error(`Xcode did not select test plan '${testPlanName}' (active: ${context.testPlanName ?? "unknown"}).`);
  return context;
}

async function workflowDrift(ctx: ToolContext, expected: WorkflowContext, result: McpCallResult): Promise<string[]> {
  const actual = await activeWorkflowContext(ctx, expected.workspaceIdentifier);
  const data = resultData(result);
  const errors: string[] = [];
  for (const key of ["schemeName", "testPlanName"] as const) {
    const returnedKey = key === "testPlanName" ? "activeTestPlanName" : key;
    if (expected[key] && actual[key] !== expected[key]) {
      errors.push(`Xcode ${key} changed during the operation: ${expected[key]} → ${actual[key] ?? "unknown"}. Result is unverified; no automatic retry was performed.`);
    }
    if (expected[key] && isObject(data) && typeof data[returnedKey] === "string" && data[returnedKey] !== expected[key]) {
      errors.push(`The returned result belongs to ${returnedKey} '${data[returnedKey]}', not '${expected[key]}'.`);
    }
  }
  return errors;
}

async function renderPreview(
  params: JsonObject,
  ctx: ToolContext,
  onUpdate?: ToolUpdate,
) {
  const { schemeName, ...nativeParams } = params;
  const renderArgs = await argumentsWithResolvedWorkspace(ctx, "RenderPreview", nativeParams, onUpdate);
  const context = await prepareWorkflow(ctx, renderArgs.workspaceIdentifier as string | undefined, schemeName as string | undefined);
  const call = await callNativeMcpTool(ctx, "RenderPreview", renderArgs, onUpdate);
  const content = [...call.content];
  await appendPreviewSnapshotImages(content, call.protocolResult);
  const drift = await workflowDrift(ctx, context, call.protocolResult);
  content.push(...drift.map((text) => ({ type: "text" as const, text })));
  const failed = call.isError || previewResultIndicatesFailure(call.protocolResult) || drift.length > 0;

  return {
    content,
    details: {
      workflowContext: context,
      mcpTool: call.mcpToolName,
      arguments: call.arguments,
      [XCODE_MCP_ERROR_DETAIL]: failed,
    },
    ...(failed ? { isError: true } : {}),
  };
}

async function buildWithDiagnostics(
  params: {
    workspaceIdentifier?: string;
    schemeName?: string;
    arguments?: JsonObject;
    includeBuildLog?: "onFailure" | "always" | "never";
    includeNavigatorIssues?: boolean;
  },
  ctx: ToolContext,
  onUpdate?: ToolUpdate,
) {
  const suppliedArgs = { ...params.arguments, ...(params.workspaceIdentifier ? { workspaceIdentifier: params.workspaceIdentifier } : {}) };
  const buildArgs = await argumentsWithResolvedWorkspace(ctx, "BuildProject", suppliedArgs, onUpdate);
  const context = await prepareWorkflow(ctx, buildArgs.workspaceIdentifier as string | undefined, params.schemeName);
  const buildCall = await callNativeMcpTool(ctx, "BuildProject", buildArgs, onUpdate);
  const drift = await workflowDrift(ctx, context, buildCall.protocolResult);
  const buildFailed = buildCall.isError || resultIndicatesBuildFailure(buildCall.protocolResult) || drift.length > 0;
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
    ...drift.map((text) => ({ type: "text" as const, text })),
  ];
  const details: JsonObject = {
    workflowContext: context,
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

type TestSpecifier = { targetName: string; testIdentifier: string };

export async function verifyXcodeTestBundle(
  reportedPath: string,
  startedAt: number,
  schemeName: string | undefined,
  readSummary: (path: string) => Promise<JsonObject>,
  derivedDataRoot = join(homedir(), "Library/Developer/Xcode/DerivedData"),
): Promise<{ path: string; summary: JsonObject }> {
  if (!reportedPath.endsWith(".xcresult")) throw new Error("Xcode did not return a .xcresult bundle path.");
  const hasManifest = async (path: string) => {
    try { return (await stat(join(path, "Info.plist"))).isFile(); } catch { return false; }
  };
  let paths = await hasManifest(reportedPath) ? [reportedPath] : [];
  if (paths.length === 0) {
    // Xcode 27 sometimes exports the bundle before Info.plist is finalized. Read the
    // original with the same unique bundle name; never repair the exported copy.
    const entries = await readdir(derivedDataRoot, { withFileTypes: true }).catch(() => []);
    const originals = entries.filter((entry) => entry.isDirectory())
      .map((entry) => join(derivedDataRoot, entry.name, "Logs/Test", basename(reportedPath)));
    paths = (await Promise.all(originals.map(async (path) => await hasManifest(path) ? path : undefined)))
      .filter((path): path is string => path !== undefined);
  }
  if (paths.length !== 1) throw new Error(`Cannot verify '${reportedPath}': no unique finalized result bundle. Xcode's exported copy may be incomplete.`);

  const summary = await readSummary(paths[0]);
  const startTime = typeof summary.startTime === "number" ? summary.startTime * 1000 : NaN;
  const finishTime = typeof summary.finishTime === "number" ? summary.finishTime * 1000 : NaN;
  if (!Number.isFinite(startTime) || startTime < startedAt - 2000 || startTime > Date.now() + 2000 ||
      !Number.isFinite(finishTime) || finishTime < startTime || finishTime > Date.now() + 2000) {
    throw new Error("The result bundle is stale or has no valid execution timestamps.");
  }
  if (schemeName && summary.title !== `Test - ${schemeName}`) throw new Error("The result bundle belongs to a different scheme.");
  if (summary.result !== "Passed" || typeof summary.totalTestCount !== "number" || summary.totalTestCount <= 0 ||
      summary.failedTests !== 0 || summary.skippedTests !== 0) {
    throw new Error("The result bundle does not confirm a complete, successful test run.");
  }
  return { path: paths[0], summary };
}

async function runVerifiedTests(
  params: { workspaceIdentifier?: string; schemeName?: string; testPlanName?: string; tests?: TestSpecifier[] },
  ctx: ToolContext,
  exec: ExtensionAPI["exec"],
  onUpdate?: ToolUpdate,
) {
  const toolName = params.tests ? "RunSomeTests" : "RunAllTests";
  const args = await argumentsWithResolvedWorkspace(ctx, toolName, {
    ...(params.workspaceIdentifier ? { workspaceIdentifier: params.workspaceIdentifier } : {}),
    ...(params.tests ? { tests: params.tests } : {}),
  }, onUpdate);
  const context = await prepareWorkflow(ctx, args.workspaceIdentifier as string | undefined, params.schemeName, params.testPlanName);
  const startedAt = Date.now();
  const call = await callNativeMcpTool(ctx, toolName, args, onUpdate);
  const data = resultData(call.protocolResult);
  const errors = await workflowDrift(ctx, context, call.protocolResult);
  const counts = findTestCounts(data);
  if (call.isError || resultIndicatesTestFailure(call.protocolResult)) errors.push("Xcode reported a failed, cancelled, empty, or incomplete test run.");
  if (!counts || typeof counts.total !== "number" || counts.total <= 0) errors.push("Xcode returned no executed-test counts.");
  if (params.tests) {
    const results = isObject(data) && Array.isArray(data.results) ? data.results : [];
    for (const test of params.tests) {
      const matches = results.filter((result) => isObject(result) && result.targetName === test.targetName &&
        typeof result.identifier === "string" && (result.identifier === test.testIdentifier || result.identifier.startsWith(`${test.testIdentifier}/`)));
      if (matches.length === 0 || matches.some((result) => !isObject(result) || !/^(passed|expected failure)$/i.test(String(result.state)))) {
        errors.push(`Requested test was not confirmed successful: ${test.targetName}/${test.testIdentifier}.`);
      }
    }
  }
  let bundle: { path: string; summary: JsonObject } | undefined;
  if (errors.length === 0) {
    try {
      if (!isObject(data) || typeof data.xcresultBundlePath !== "string") throw new Error("Xcode returned no result bundle path.");
      bundle = await verifyXcodeTestBundle(data.xcresultBundlePath, startedAt, context.schemeName, async (path) => {
        const result = await exec("xcrun", ["xcresulttool", "get", "test-results", "summary", "--path", path], { signal: ctx.signal, timeout: 30_000 });
        if (result.code !== 0) throw new Error(`Cannot read the result bundle: ${result.stderr}`);
        const summary: unknown = JSON.parse(result.stdout);
        if (!isObject(summary)) throw new Error("Invalid xcresulttool summary.");
        return summary;
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const failed = errors.length > 0;
  const content: PiContent[] = [{ type: "text", text: failed
    ? `Xcode test run is not verified:\n${errors.join("\n")}`
    : `Verified ${bundle!.summary.totalTestCount} tests for ${context.schemeName ?? "the active scheme"}: passed, no failures or skips.\nResult bundle: ${bundle!.path}` }];
  if (isObject(data) && typeof data.fullSummaryPath === "string") content.push({ type: "text", text: `Xcode summary: ${data.fullSummaryPath}` });
  if (failed && findNativeMcpTool(ctx, "GetBuildLog")) {
    const log = await callNativeMcpTool(ctx, "GetBuildLog", context.workspaceIdentifier ? { workspaceIdentifier: context.workspaceIdentifier } : {});
    content.push(...sectionedContent("GetBuildLog", log));
  }
  return {
    content,
    structuredContent: JSON.parse(JSON.stringify({ nativeResult: data, workflowContext: context, verified: !failed, verificationErrors: errors, verifiedBundlePath: bundle?.path })),
    details: { workflowContext: context, verificationErrors: errors, [XCODE_MCP_ERROR_DETAIL]: failed },
    ...(failed ? { isError: true } : {}),
  };
}

export default function xcodeMcpExtension(pi: ExtensionAPI) {
  if (typeof pi.registerMcpServer !== "function") {
    throw new Error("pi-xcode-mcp 0.4.0 requires Pi 0.99.0 or later.");
  }

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
    name: "xcode_test",
    label: "Xcode Test",
    description: "Run selected tests or the active test plan, auto-open the matching project, verify scheme/test-plan stability and requested coverage, and confirm execution using a fresh readable xcresult bundle.",
    promptSnippet: "Run and verify Xcode tests, including headless workspaces",
    promptGuidelines: [
      "Prefer xcode_test for test verification. Pass schemeName and testPlanName when the task requires specific ones.",
      "xcode_test never retries automatically or reports an empty, cancelled, incomplete, stale, or wrong-scheme run as verified.",
    ],
    parameters: TestParams,
    outputSchema: Type.Record(Type.String(), Type.Any()),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runVerifiedTests(params, toolContextWithSignal(ctx, signal), pi.exec.bind(pi), onUpdate as ToolUpdate | undefined);
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
