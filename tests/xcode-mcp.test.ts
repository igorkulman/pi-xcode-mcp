import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import xcodeMcpExtension, {
  parseXcodeWorkspaces,
  resultIndicatesBuildFailure,
  resultIndicatesTestFailure,
  selectXcodeWorkspace,
} from "../extensions/xcode-mcp/index.js";

function createExtensionHarness() {
  const handlers = new Map<string, (event: any) => unknown>();
  const tools = new Map<string, any>();
  const servers = new Map<string, any>();
  const fakePi = {
    registerMcpServer(name: string, config: unknown) {
      servers.set(name, config);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: (event: any) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;

  xcodeMcpExtension(fakePi);
  return { handlers, tools, servers };
}

test("registers Xcode through Pi's native MCP client", () => {
  const { servers, tools } = createExtensionHarness();

  assert.deepEqual(servers.get("xcode"), {
    command: "xcrun",
    args: ["mcpbridge"],
    exposure: "codemode",
    timeout: 120,
  });
  assert.deepEqual(Array.from(tools.keys()).sort(), [
    "xcode_build",
    "xcode_mcp_call",
    "xcode_render_preview",
  ]);
});

test("reports the minimum Pi version when native MCP is unavailable", () => {
  const oldPi = {
    registerTool() {},
    on() {},
  } as unknown as ExtensionAPI;

  assert.throws(
    () => xcodeMcpExtension(oldPi),
    /requires Pi 0\.99\.0 or later/,
  );
});

test("parses workspace identifiers from headless MCP text output", () => {
  const result = {
    content: [
      {
        type: "text",
        text: [
          "* workspaceIdentifier: workspace-headless, workspacePath: /tmp/App/App.xcodeproj",
          "* workspaceIdentifier: windowtab-app, workspacePath: /tmp/App/App.xcodeproj",
        ].join("\n"),
      },
    ],
  };

  assert.deepEqual(parseXcodeWorkspaces(result), [
    { workspaceIdentifier: "workspace-headless", workspacePath: "/tmp/App/App.xcodeproj" },
    { workspaceIdentifier: "windowtab-app", workspacePath: "/tmp/App/App.xcodeproj" },
  ]);
});

test("prefers the matching headless workspace when Xcode reports the same project twice", () => {
  const selected = selectXcodeWorkspace([
    { workspaceIdentifier: "windowtab-app", workspacePath: "/tmp/App/App.xcodeproj" },
    { workspaceIdentifier: "workspace-headless", workspacePath: "/tmp/App/App.xcodeproj" },
    { workspaceIdentifier: "workspace-other", workspacePath: "/tmp/Other/Other.xcodeproj" },
  ], "/tmp/App");

  assert.equal(selected?.workspaceIdentifier, "workspace-headless");
});

test("does not guess between unrelated workspaces", () => {
  const selected = selectXcodeWorkspace([
    { workspaceIdentifier: "workspace-one", workspacePath: "/tmp/One/One.xcodeproj" },
    { workspaceIdentifier: "workspace-two", workspacePath: "/tmp/Two/Two.xcodeproj" },
  ], "/tmp/Unrelated");

  assert.equal(selected, undefined);
});

test("detects structured build failures", () => {
  assert.equal(resultIndicatesBuildFailure({
    structuredContent: { buildSucceeded: false },
  }), true);
});

test("treats an all-not-run Xcode test result as a failure", () => {
  assert.equal(resultIndicatesTestFailure({
    structuredContent: {
      counts: { total: 12, passed: 0, failed: 0, notRun: 12 },
    },
  }), true);
});

test("maps logical failures from native Xcode MCP tools onto Pi tool errors", () => {
  const { handlers } = createExtensionHarness();
  const result = handlers.get("tool_result")?.({
    toolName: "mcp__xcode__RunSomeTests",
    content: [{ type: "text", text: "No tests ran" }],
    structuredContent: {
      content: [{ type: "text", text: "No tests ran" }],
      structuredContent: { counts: { total: 3, passed: 0, failed: 0, notRun: 3 } },
    },
    isError: false,
  });

  assert.deepEqual(result, { isError: true });
});

test("build wrapper fetches native diagnostics after a logical build failure", async () => {
  const { tools } = createExtensionHarness();
  const buildTool = tools.get("xcode_build");
  const calls: Array<{ name: string; args: any }> = [];
  const workspaceMessage = "* workspaceIdentifier: workspace-test, workspacePath: /tmp/App/App.xcodeproj";
  const context = {
    cwd: "/tmp/App",
    tools: [
      { name: "mcp__xcode__XcodeListWorkspaces", parameters: { type: "object", properties: {} } },
      { name: "mcp__xcode__BuildProject", parameters: { type: "object", properties: { workspaceIdentifier: { type: "string" } } } },
      { name: "mcp__xcode__GetBuildLog", parameters: { type: "object", properties: { workspaceIdentifier: { type: "string" } } } },
      { name: "mcp__xcode__XcodeListNavigatorIssues", parameters: { type: "object", properties: { workspaceIdentifier: { type: "string" } } } },
    ],
    async executeTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === "mcp__xcode__XcodeListWorkspaces") {
        return {
          isError: false,
          result: {
            content: [{ type: "text", text: workspaceMessage }],
            structuredContent: {
              content: [{ type: "text", text: workspaceMessage }],
              structuredContent: { message: workspaceMessage },
            },
          },
        };
      }

      const structuredContent = name === "mcp__xcode__BuildProject"
        ? { buildSucceeded: false }
        : { message: "diagnostic output" };
      return {
        isError: false,
        result: {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent: {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent,
          },
        },
      };
    },
  };

  const result = await buildTool.execute("build-call", {}, undefined, undefined, context);

  assert.deepEqual(calls.map((call) => call.name), [
    "mcp__xcode__XcodeListWorkspaces",
    "mcp__xcode__BuildProject",
    "mcp__xcode__GetBuildLog",
    "mcp__xcode__XcodeListNavigatorIssues",
  ]);
  assert.equal(calls.slice(1).every((call) => call.args.workspaceIdentifier === "workspace-test"), true);
  assert.equal(result.isError, true);
  assert.match(result.content.map((block: any) => block.type === "text" ? block.text : "").join("\n"), /GetBuildLog/);
  assert.match(result.content.map((block: any) => block.type === "text" ? block.text : "").join("\n"), /Issue Navigator/);
});

test("preview wrapper resolves the workspace and attaches the snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-xcode-mcp-test-"));
  const snapshotPath = join(directory, "preview.png");
  await writeFile(snapshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    const { tools } = createExtensionHarness();
    const previewTool = tools.get("xcode_render_preview");
    const calls: Array<{ name: string; args: any }> = [];
    const nativeTools = [
      {
        name: "mcp__xcode__XcodeListWorkspaces",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "mcp__xcode__RenderPreview",
        parameters: {
          type: "object",
          properties: {
            sourceFilePath: { type: "string" },
            workspaceIdentifier: { type: "string" },
          },
        },
      },
    ];
    const context = Object.create({
      get cwd() {
        return directory;
      },
      get tools() {
        return nativeTools;
      },
      async executeTool(name: string, args: any) {
        calls.push({ name, args });
        if (name === "mcp__xcode__XcodeListWorkspaces") {
          const message = `* workspaceIdentifier: workspace-test, workspacePath: ${directory}/App.xcodeproj`;
          return {
            isError: false,
            result: {
              content: [{ type: "text", text: message }],
              structuredContent: {
                content: [{ type: "text", text: message }],
                structuredContent: { message },
              },
            },
          };
        }

        const structuredContent = { previewSnapshotPath: snapshotPath };
        return {
          isError: false,
          result: {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent: {
              content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              structuredContent,
            },
          },
        };
      },
    });

    const result = await previewTool.execute(
      "preview-call",
      { sourceFilePath: "App/MyView.swift" },
      undefined,
      undefined,
      context,
    );

    assert.deepEqual(calls.map((call) => call.name), [
      "mcp__xcode__XcodeListWorkspaces",
      "mcp__xcode__RenderPreview",
    ]);
    assert.equal(calls[1].args.workspaceIdentifier, "workspace-test");
    assert.equal(result.isError, undefined);
    assert.equal(result.content.some((block: any) => block.type === "image" && block.mimeType === "image/png"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
