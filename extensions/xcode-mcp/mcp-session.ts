import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";

export type JsonObject = Record<string, unknown>;

export type ChildProcessTerminationOptions = {
  terminateAfterMs?: number;
  forceKillAfterMs?: number;
  failAfterMs?: number;
};

/** Gracefully closes a child, escalates to SIGKILL, and never waits without a deadline. */
export async function terminateChildProcess(
  child: ChildProcessWithoutNullStreams,
  options: ChildProcessTerminationOptions = {},
): Promise<void> {
  const terminateAfterMs = options.terminateAfterMs ?? 750;
  const forceKillAfterMs = options.forceKillAfterMs ?? 2_000;
  const failAfterMs = options.failAfterMs ?? 4_000;
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;

  child.stdin.end();
  if (hasExited()) return;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let terminateTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let failureTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (terminateTimer) clearTimeout(terminateTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (failureTimer) clearTimeout(failureTimer);
    };
    const handleExit = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolvePromise();
    };
    const handleFailure = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      child.removeListener("exit", handleExit);
      rejectPromise(new Error(
        `Child process ${child.pid ?? "unknown"} did not exit within ${failAfterMs} ms after shutdown signals.`,
      ));
    };

    child.once("exit", handleExit);
    if (hasExited()) {
      handleExit();
      return;
    }

    terminateTimer = setTimeout(() => {
      if (!hasExited()) child.kill("SIGTERM");
    }, terminateAfterMs);
    forceKillTimer = setTimeout(() => {
      if (!hasExited()) child.kill("SIGKILL");
    }, forceKillAfterMs);
    failureTimer = setTimeout(handleFailure, failAfterMs);
  });
}

export type McpServerNotificationHandlers = {
  toolsListChanged?: () => void;
};

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  annotations?: JsonObject;
};

type RegisteredToolInfo = {
  piToolName: string;
  mcpToolName: string;
  inputSchema?: JsonObject;
};

export type McpToolCatalogEntry = {
  tool: McpTool;
  info: RegisteredToolInfo;
};

export type McpToolCatalogChange = {
  registrations: McpToolCatalogEntry[];
  addedPiToolNames: string[];
  removedPiToolNames: string[];
};

/** Applies catalog additions and removals while preserving unrelated active Pi tools. */
export function reconcileActiveToolNames(
  activePiToolNames: Iterable<string>,
  change: Pick<McpToolCatalogChange, "addedPiToolNames" | "removedPiToolNames">,
): string[] {
  const nextActivePiToolNames = new Set(activePiToolNames);
  for (const name of change.addedPiToolNames) nextActivePiToolNames.add(name);
  for (const name of change.removedPiToolNames) nextActivePiToolNames.delete(name);
  return Array.from(nextActivePiToolNames);
}

/** Serializes asynchronous session work and remains usable after one operation fails. */
export class SerialAsyncQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  onIdle(): Promise<void> {
    return this.tail;
  }
}

/** Invalidates superseded connection attempts and permanently closes the gate at shutdown. */
export class McpConnectionGate {
  private generation = 0;
  private shuttingDown = false;

  beginConnection(): number {
    if (this.shuttingDown) {
      throw new Error("Xcode MCP session is shutting down.");
    }

    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return !this.shuttingDown && generation === this.generation;
  }

  assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) {
      throw new Error("Xcode MCP connection attempt was superseded or cancelled.");
    }
  }

  cancelPending(): void {
    this.generation += 1;
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.cancelPending();
  }
}

export type XcodeWindow = {
  tabIdentifier: string;
  workspacePath?: string;
};

export const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
export const TOOL_TIMEOUT_ENV_NAME = "XCODE_MCP_TOOL_TIMEOUT_MS";
const PREVIEW_TIMEOUT_MARGIN_MS = 5_000;

/** Dispatches supported server notifications and leaves responses and requests untouched. */
export function dispatchMcpServerNotification(
  message: JsonObject,
  handlers: McpServerNotificationHandlers,
): boolean {
  if (message.id !== undefined || message.method !== "notifications/tools/list_changed") {
    return false;
  }

  handlers.toolsListChanged?.();
  return true;
}

/** Resolves the optional process-wide tool deadline override. */
export function parseToolTimeoutMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TOOL_TIMEOUT_MS;

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${TOOL_TIMEOUT_ENV_NAME} must be a positive integer in milliseconds.`);
  }

  const timeoutMs = Number(normalized);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${TOOL_TIMEOUT_ENV_NAME} must be a positive integer in milliseconds.`);
  }

  return timeoutMs;
}

/** Keeps the MCP client alive slightly longer than Xcode's requested preview deadline. */
export function toolTimeoutMsForCall(
  toolName: string,
  args: JsonObject,
  configuredTimeoutMs: number,
): number {
  const previewTimeoutSeconds = args.timeout;
  const isPreviewTool = toolName === "RenderPreview" || toolName === "XcodeRenderPreview";
  if (!isPreviewTool || !Number.isSafeInteger(previewTimeoutSeconds) || (previewTimeoutSeconds as number) <= 0) {
    return configuredTimeoutMs;
  }

  const previewTimeoutMs = (previewTimeoutSeconds as number) * 1_000 + PREVIEW_TIMEOUT_MARGIN_MS;
  return Math.max(configuredTimeoutMs, previewTimeoutMs);
}

export function stripLeadingXcode(name: string): string {
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

export function schemaRequiresArgument(schema: unknown, argumentName: string): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const required = (schema as JsonObject).required;
  return Array.isArray(required) && required.includes(argumentName);
}

/** Owns the current MCP tool snapshot and computes registrations and removals after refreshes. */
export class McpToolCatalog {
  private byPiName = new Map<string, McpToolCatalogEntry>();
  private byMcpName = new Map<string, McpToolCatalogEntry>();
  private mirroredPiToolNames = new Set<string>();
  private readonly reservedPiToolNames: Set<string>;

  constructor(reservedPiToolNames: Iterable<string> = []) {
    this.reservedPiToolNames = new Set(reservedPiToolNames);
  }

  get size(): number {
    return this.byPiName.size;
  }

  replace(tools: McpTool[]): McpToolCatalogChange {
    const nextByPiName = new Map<string, McpToolCatalogEntry>();
    const nextByMcpName = new Map<string, McpToolCatalogEntry>();
    const nextMirroredPiToolNames = new Set<string>();

    for (const tool of tools) {
      const info: RegisteredToolInfo = {
        piToolName: toPiToolName(tool.name),
        mcpToolName: tool.name,
        inputSchema: tool.inputSchema,
      };
      const entry = { tool, info };
      nextByPiName.set(info.piToolName, entry);
      nextByMcpName.set(info.mcpToolName, entry);
      if (!this.reservedPiToolNames.has(info.piToolName)) {
        nextMirroredPiToolNames.add(info.piToolName);
      }
    }

    const addedPiToolNames = Array.from(nextMirroredPiToolNames)
      .filter((name) => !this.mirroredPiToolNames.has(name));
    const removedPiToolNames = Array.from(this.mirroredPiToolNames)
      .filter((name) => !nextMirroredPiToolNames.has(name));

    this.byPiName = nextByPiName;
    this.byMcpName = nextByMcpName;
    this.mirroredPiToolNames = nextMirroredPiToolNames;

    return {
      registrations: Array.from(nextByPiName.values())
        .filter((entry) => !this.reservedPiToolNames.has(entry.info.piToolName)),
      addedPiToolNames,
      removedPiToolNames,
    };
  }

  values(): RegisteredToolInfo[] {
    return Array.from(this.byPiName.values()).map((entry) => entry.info);
  }

  lines(): string[] {
    if (this.byPiName.size === 0) return ["No Xcode MCP tools discovered yet."];

    return this.values()
      .sort((a, b) => a.piToolName.localeCompare(b.piToolName))
      .map((tool) => `${tool.piToolName} → ${tool.mcpToolName}`);
  }

  resolveMcpToolName(name: string): string {
    if (this.byMcpName.has(name)) return name;
    return this.byPiName.get(name)?.info.mcpToolName ?? name;
  }

  findMcpToolName(...candidates: string[]): string | undefined {
    for (const candidate of candidates) {
      if (this.byMcpName.has(candidate)) return candidate;
      const byPiName = this.byPiName.get(candidate) ?? this.byPiName.get(toPiToolName(candidate));
      if (byPiName) return byPiName.info.mcpToolName;
    }
    return undefined;
  }

  requiresArgument(mcpToolName: string, argumentName: string): boolean {
    return schemaRequiresArgument(this.byMcpName.get(mcpToolName)?.info.inputSchema, argumentName);
  }
}

function xcodeWorkspaceRoot(workspacePath: string): string {
  const absolute = resolve(workspacePath);
  return absolute.endsWith(".xcodeproj") || absolute.endsWith(".xcworkspace") ? dirname(absolute) : absolute;
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function scoreWindowForCwd(window: XcodeWindow, cwd: string): number {
  if (!window.workspacePath) return 0;

  const absoluteCwd = resolve(cwd);
  const absoluteWorkspacePath = resolve(window.workspacePath);
  const workspaceRoot = xcodeWorkspaceRoot(window.workspacePath);

  if (absoluteWorkspacePath === absoluteCwd) return 5;
  if (workspaceRoot === absoluteCwd) return 4;
  if (pathContains(workspaceRoot, absoluteCwd)) return 3;
  if (pathContains(absoluteCwd, workspaceRoot)) return 2;

  return 0;
}

/** Selects one positively matched Xcode workspace and rejects ambiguous or unrelated windows. */
export function selectMatchingXcodeWindow(windows: XcodeWindow[], cwd: string): XcodeWindow | undefined {
  const scored = windows.map((window) => ({ window, score: scoreWindowForCwd(window, cwd) }));
  const bestScore = Math.max(0, ...scored.map((item) => item.score));
  if (bestScore === 0) return undefined;

  const candidates = scored.filter((item) => item.score === bestScore).map((item) => item.window);
  return candidates.length === 1 ? candidates[0] : undefined;
}
