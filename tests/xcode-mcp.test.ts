import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import xcodeMcpExtension, {
  mcpArgumentValidationError,
  mcpResultToPiContent,
  parseXcodeWorkspaces,
  resultIndicatesTestFailure,
  selectXcodeWorkspace,
} from "../extensions/xcode-mcp/index.js";

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

test("validates generic MCP arguments against the advertised schema", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  };

  const error = mcpArgumentValidationError(schema, { workspacePath: "/tmp/App.xcodeproj" });

  assert.match(error ?? "", /unsupported argument\(s\): workspacePath/);
  assert.match(error ?? "", /required properties path/);
});

test("rejects malformed selected-test arguments before calling Xcode", () => {
  const schema = {
    type: "object",
    properties: {
      tests: {
        type: "array",
        items: {
          type: "object",
          properties: {
            targetName: { type: "string" },
            testIdentifier: { type: "string" },
          },
          required: ["targetName", "testIdentifier"],
        },
      },
    },
    required: ["tests"],
  };

  const error = mcpArgumentValidationError(schema, { tests: ["Suite/testName()"] });

  assert.match(error ?? "", /must be object/);
});

test("accepts omitted workspace context because Pi resolves it", () => {
  const schema = {
    type: "object",
    properties: {
      workspaceIdentifier: { type: "string" },
    },
    required: ["workspaceIdentifier"],
  };

  assert.equal(mcpArgumentValidationError(schema, {}), undefined);
});

test("does not duplicate JSON text and equivalent structured content", () => {
  const value = { activeScheme: "Debug" };
  const content = mcpResultToPiContent({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  });

  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, "text");
  assert.doesNotMatch(content[0]?.type === "text" ? content[0].text : "", /Structured content/);
});

test("does not duplicate Xcode's structured message envelope", () => {
  const message = "* workspaceIdentifier: workspace-live, workspacePath: /tmp/App.xcodeproj";
  const content = mcpResultToPiContent({
    content: [{ type: "text", text: message }],
    structuredContent: { message },
  });

  assert.deepEqual(content, [{ type: "text", text: message }]);
});

test("preserves structured fields alongside a duplicate message", () => {
  const message = "Active scheme is Debug";
  const content = mcpResultToPiContent({
    content: [{ type: "text", text: message }],
    structuredContent: { message, activeScheme: "Debug" },
  });

  assert.equal(content.length, 2);
  assert.match(content[1]?.type === "text" ? content[1].text : "", /activeScheme/);
  assert.doesNotMatch(content[1]?.type === "text" ? content[1].text : "", /Active scheme is Debug/);
});

test("treats an all-not-run Xcode test result as a failure", () => {
  assert.equal(resultIndicatesTestFailure({
    structuredContent: {
      counts: { total: 12, passed: 0, failed: 0, notRun: 12 },
    },
  }), true);
});

test("maps MCP failures onto Pi tool-result errors", () => {
  const handlers = new Map<string, (event: any) => unknown>();
  const fakePi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: (event: any) => unknown) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  xcodeMcpExtension(fakePi);

  const result = handlers.get("tool_result")?.({
    toolName: "xcode_run_some_tests",
    details: { xcodeMcpError: true },
  });

  assert.deepEqual(result, { isError: true });
});
