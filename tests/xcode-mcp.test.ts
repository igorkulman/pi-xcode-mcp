import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";

import {
  DEFAULT_TOOL_TIMEOUT_MS,
  dispatchMcpServerNotification,
  McpConnectionGate,
  McpToolCatalog,
  parseToolTimeoutMs,
  SerialAsyncQueue,
  reconcileActiveToolNames,
  selectMatchingXcodeWindow,
  terminateChildProcess,
  toolTimeoutMsForCall,
  type McpTool,
  type XcodeWindow,
} from "../extensions/xcode-mcp/mcp-session.js";

const mainWindow: XcodeWindow = {
  tabIdentifier: "main-tab",
  workspacePath: "/workspace/Amis-Wifi",
};

const featureWindow: XcodeWindow = {
  tabIdentifier: "feature-tab",
  workspacePath: "/workspace/Amis-Wifi-feature",
};

describe("Xcode worktree selection", () => {
  it("selects the window whose workspace matches the current worktree", () => {
    const selected = selectMatchingXcodeWindow(
      [mainWindow, featureWindow],
      "/workspace/Amis-Wifi-feature",
    );

    assert.deepEqual(selected, featureWindow);
  });

  it("matches a workspace when Pi starts in one of its subdirectories", () => {
    const selected = selectMatchingXcodeWindow(
      [mainWindow],
      "/workspace/Amis-Wifi/Sources/Feature",
    );

    assert.deepEqual(selected, mainWindow);
  });

  it("does not select a sole window from a different worktree", () => {
    const selected = selectMatchingXcodeWindow(
      [mainWindow],
      "/workspace/Amis-Wifi-unopened-feature",
    );

    assert.equal(selected, undefined);
  });

  it("does not choose between equally ranked matching windows", () => {
    const selected = selectMatchingXcodeWindow(
      [
        { tabIdentifier: "first", workspacePath: "/workspace/Amis-Wifi" },
        { tabIdentifier: "second", workspacePath: "/workspace/Amis-Wifi" },
      ],
      "/workspace/Amis-Wifi",
    );

    assert.equal(selected, undefined);
  });
});

describe("Xcode MCP tool timeouts", () => {
  it("uses a ten-minute default and accepts a positive millisecond override", () => {
    assert.equal(DEFAULT_TOOL_TIMEOUT_MS, 600_000);
    assert.equal(parseToolTimeoutMs(undefined), DEFAULT_TOOL_TIMEOUT_MS);
    assert.equal(parseToolTimeoutMs("900000"), 900_000);
  });

  it("rejects invalid timeout overrides", () => {
    for (const value of ["", "0", "-1", "100.5", "later"]) {
      assert.throws(
        () => parseToolTimeoutMs(value),
        /XCODE_MCP_TOOL_TIMEOUT_MS must be a positive integer in milliseconds/,
      );
    }
  });

  it("extends the client deadline beyond a requested preview timeout", () => {
    assert.equal(
      toolTimeoutMsForCall("RenderPreview", { timeout: 900 }, DEFAULT_TOOL_TIMEOUT_MS),
      905_000,
    );
    assert.equal(
      toolTimeoutMsForCall("RenderPreview", { timeout: 120 }, DEFAULT_TOOL_TIMEOUT_MS),
      DEFAULT_TOOL_TIMEOUT_MS,
    );
  });

  it("keeps the configured deadline for other tools", () => {
    assert.equal(
      toolTimeoutMsForCall("BuildProject", {}, DEFAULT_TOOL_TIMEOUT_MS),
      DEFAULT_TOOL_TIMEOUT_MS,
    );
  });
});

describe("Xcode MCP tool catalog", () => {
  const renderPreview: McpTool = {
    name: "RenderPreview",
    description: "Render a preview",
    inputSchema: { type: "object", required: ["tabIdentifier", "sourceFilePath"] },
  };
  const readFile: McpTool = {
    name: "XcodeRead",
    description: "Read a project file",
    inputSchema: { type: "object", required: ["tabIdentifier", "filePath"] },
  };
  const buildProject: McpTool = {
    name: "BuildProject",
    description: "Build the active project",
    inputSchema: { type: "object", required: ["tabIdentifier"] },
  };
  const nativeBuildCollision: McpTool = {
    name: "XcodeBuild",
    description: "Build without diagnostics",
    inputSchema: { type: "object", required: ["tabIdentifier"] },
  };

  it("keeps dedicated wrappers reserved while registering mirrored tools", () => {
    const catalog = new McpToolCatalog(["xcode_build", "xcode_render_preview"]);
    const change = catalog.replace([renderPreview, readFile, buildProject, nativeBuildCollision]);

    assert.deepEqual(
      change.registrations.map((entry) => entry.info.piToolName).sort(),
      ["xcode_build_project", "xcode_read"],
    );
    assert.deepEqual(change.addedPiToolNames.sort(), ["xcode_build_project", "xcode_read"]);
    assert.deepEqual(change.removedPiToolNames, []);
    assert.equal(catalog.findMcpToolName("RenderPreview"), "RenderPreview");
    assert.equal(catalog.findMcpToolName("XcodeBuild"), "XcodeBuild");
    assert.equal(catalog.requiresArgument("XcodeRead", "tabIdentifier"), true);
  });

  it("re-registers current definitions and reports removed mirrored tools", () => {
    const catalog = new McpToolCatalog(["xcode_build", "xcode_render_preview"]);
    catalog.replace([renderPreview, readFile, buildProject, nativeBuildCollision]);

    const updatedBuild: McpTool = {
      ...buildProject,
      description: "Build the selected project",
      inputSchema: { type: "object", required: ["tabIdentifier", "configuration"] },
    };
    const change = catalog.replace([renderPreview, updatedBuild, nativeBuildCollision]);

    assert.deepEqual(change.addedPiToolNames, []);
    assert.deepEqual(change.removedPiToolNames, ["xcode_read"]);
    assert.deepEqual(
      change.registrations.map((entry) => entry.info.piToolName),
      ["xcode_build_project"],
    );
    assert.equal(change.registrations[0]?.tool.description, "Build the selected project");
    assert.equal(catalog.requiresArgument("BuildProject", "configuration"), true);
    assert.equal(catalog.findMcpToolName("XcodeRead"), undefined);
    assert.equal(catalog.size, 3);

    const readded = catalog.replace([renderPreview, updatedBuild, readFile, nativeBuildCollision]);
    assert.deepEqual(readded.addedPiToolNames, ["xcode_read"]);
    assert.deepEqual(readded.removedPiToolNames, []);
  });

  it("activates added tools and deactivates removed tools without changing unrelated tools", () => {
    assert.deepEqual(
      reconcileActiveToolNames(
        ["read", "xcode_read"],
        { addedPiToolNames: ["xcode_build_project"], removedPiToolNames: ["xcode_read"] },
      ),
      ["read", "xcode_build_project"],
    );
  });
});

describe("Xcode MCP connection lifecycle", () => {
  it("force-kills a bridge process that ignores SIGTERM", { timeout: 2_000 }, async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    try {
      await once(child.stdout, "data");
      await terminateChildProcess(child, {
        terminateAfterMs: 10,
        forceKillAfterMs: 30,
        failAfterMs: 500,
      });
      assert.equal(child.signalCode, "SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });

  it("supersedes older attempts, supports disconnect, and rejects work after shutdown", () => {
    const gate = new McpConnectionGate();
    const first = gate.beginConnection();
    gate.assertCurrent(first);

    const second = gate.beginConnection();
    assert.throws(() => gate.assertCurrent(first), /superseded or cancelled/);
    gate.assertCurrent(second);

    gate.cancelPending();
    assert.throws(() => gate.assertCurrent(second), /superseded or cancelled/);
    gate.assertCurrent(gate.beginConnection());

    gate.shutdown();
    assert.throws(() => gate.beginConnection(), /shutting down/);
  });
});

describe("Xcode MCP server notifications", () => {
  it("serializes catalog refreshes and continues after a failed refresh", async () => {
    const queue = new SerialAsyncQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = queue.enqueue(async () => {
      events.push("second");
      return 2;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["first:start"]);
    releaseFirst?.();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(events, ["first:start", "first:end", "second"]);

    await assert.rejects(
      queue.enqueue(async () => {
        throw new Error("refresh failed");
      }),
      /refresh failed/,
    );
    assert.equal(await queue.enqueue(async () => 3), 3);
    await queue.onIdle();
  });

  it("dispatches tool-list changes without treating responses as notifications", () => {
    let refreshCount = 0;
    const handlers = { toolsListChanged: () => { refreshCount += 1; } };

    assert.equal(
      dispatchMcpServerNotification(
        { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
        handlers,
      ),
      true,
    );
    assert.equal(
      dispatchMcpServerNotification(
        { jsonrpc: "2.0", id: 7, method: "notifications/tools/list_changed" },
        handlers,
      ),
      false,
    );
    assert.equal(
      dispatchMcpServerNotification(
        { jsonrpc: "2.0", method: "notifications/message" },
        handlers,
      ),
      false,
    );
    assert.equal(refreshCount, 1);
  });
});
