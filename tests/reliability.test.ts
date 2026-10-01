import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, {
  discoverXcodeWorkspace, parseXcodeWorkspaces, resultIndicatesBuildFailure,
  resultIndicatesTestFailure, selectXcodeWorkspace, verifyXcodeTestBundle,
} from "../extensions/xcode-mcp/index.js";

function harness(exec: any = async () => { throw new Error("Unexpected shell execution"); }) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  extension({ registerMcpServer() {}, registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: any) { handlers.set(name, handler); }, exec } as unknown as ExtensionAPI);
  return { tools, handlers };
}

function native(data: unknown, wrapped = true) {
  const content = [{ type: "text", text: JSON.stringify(data) }];
  return { isError: false, result: { content, structuredContent: wrapped ? { content, structuredContent: data } : data } };
}

function context(cwd: string, responses: Record<string, (args: any) => unknown>) {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    cwd, calls,
    tools: Object.keys(responses).map((name) => ({ name: `mcp__xcode__${name}`, parameters: {
      type: "object", properties: ["XcodeListWorkspaces", "XcodeOpenWorkspace"].includes(name) ? {} : { workspaceIdentifier: { type: "string" } },
    } })),
    async executeTool(name: string, args: any) {
      calls.push({ name, args });
      return responses[name.replace("mcp__xcode__", "")](args);
    },
  };
}

async function temporary(t: any) {
  const root = await mkdtemp(join(tmpdir(), "pi-xcode-reliability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".git"), "gitdir: test");
  return root;
}

test("never chooses a sole unrelated workspace or a pathless workspace", () => {
  for (const workspace of [
    { workspaceIdentifier: "other", workspacePath: "/tmp/Other/Other.xcodeproj" },
    { workspaceIdentifier: "unknown" },
  ]) assert.equal(selectXcodeWorkspace([workspace], "/tmp/App"), undefined);
});

test("parses a text-only JSON response from XcodeOpenWorkspace", () => {
  assert.deepEqual(parseXcodeWorkspaces({ content: [{ type: "text", text: JSON.stringify({
    workspaceIdentifier: "opened", workspacePath: "/tmp/App/App.xcodeproj",
  }) }] }), [{ workspaceIdentifier: "opened", workspacePath: "/tmp/App/App.xcodeproj" }]);
});

test("cancelled builds and test runs are failures, even with cached positive counts", () => {
  for (const status of ["cancelled", "canceled", "aborted"]) {
    assert.equal(resultIndicatesBuildFailure({ content: [{ type: "text", text: `The build was ${status}` }] }), true);
    assert.equal(resultIndicatesTestFailure({ structuredContent: {
      result: status, counts: { total: 1, passed: 1, failed: 0, notRun: 0 },
    } }), true);
  }
});

test("empty and partially unexecuted tests cannot pass", () => {
  for (const counts of [
    { total: 0, passed: 0, failed: 0, notRun: 0 },
    { total: 5, passed: 4, failed: 0, notRun: 1 },
    { total: 5, passed: 4, failed: 1, notRun: 0 },
  ]) {
    assert.equal(resultIndicatesTestFailure({ structuredContent: { counts } }), true);
    assert.equal(resultIndicatesTestFailure({ content: [{ type: "text", text: JSON.stringify({ counts }) }] }), true);
  }
});

test("a passing cancellation regression test is not mistaken for a cancelled run", () => {
  assert.equal(resultIndicatesTestFailure({ structuredContent: {
    counts: { total: 1, passed: 1, failed: 0, notRun: 0 },
    results: [{ displayName: "A cancelled build preserves state; no tests ran previously", state: "Passed" }],
  } }), false);
});

test("plain structuredContent is preserved for logical failure detection", () => {
  const { handlers } = harness();
  assert.deepEqual(handlers.get("tool_result")({ toolName: "mcp__xcode__RunSomeTests",
    content: [{ type: "text", text: "Finished" }],
    structuredContent: { counts: { total: 1, failed: 1, notRun: 0 } }, isError: false,
  }), { isError: true });
});

test("text-only JSON preview errors are mapped to failed Pi results", () => {
  const { handlers } = harness();
  assert.deepEqual(handlers.get("tool_result")({ toolName: "mcp__xcode__RenderPreview",
    content: [{ type: "text", text: JSON.stringify({ errors: ["Preview failed"] }) }], isError: false,
  }), { isError: true });
});

test("discovers the nearest project from a source subdirectory", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "App.xcodeproj"));
  await mkdir(join(root, "Sources/UI"), { recursive: true });
  assert.equal(await discoverXcodeWorkspace(join(root, "Sources/UI")), join(root, "App.xcodeproj"));
});

test("prefers a single workspace over projects, but rejects ambiguous local choices", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "App.xcodeproj"));
  await mkdir(join(root, "Other.xcodeproj"));
  await assert.rejects(discoverXcodeWorkspace(root), /Multiple Xcode/);
  await mkdir(join(root, "App.xcworkspace"));
  assert.equal(await discoverXcodeWorkspace(root), join(root, "App.xcworkspace"));
  await mkdir(join(root, "Other.xcworkspace"));
  await assert.rejects(discoverXcodeWorkspace(root), /Multiple Xcode/);
});

test("project discovery never escapes a repository boundary", async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, "Outer.xcodeproj"));
  await mkdir(join(root, "Repo/Sources"), { recursive: true });
  await writeFile(join(root, "Repo/.git"), "gitdir: nested");
  assert.equal(await discoverXcodeWorkspace(join(root, "Repo/Sources")), undefined);
});

for (const unrelatedOpen of [false, true]) {
  test(`auto-opens the local project headlessly with ${unrelatedOpen ? "an unrelated" : "no"} open project`, async (t) => {
    const root = await temporary(t);
    const project = join(root, "App.xcodeproj");
    await mkdir(project);
    const ctx = context(root, {
      XcodeListWorkspaces: () => native(unrelatedOpen ? [{ workspaceIdentifier: "unrelated", workspacePath: "/Other/Other.xcodeproj" }] : []),
      XcodeOpenWorkspace: (args) => { assert.equal(args.path, project); return native({ workspaceIdentifier: "headless", workspacePath: project }, false); },
      BuildProject: (args) => { assert.equal(args.workspaceIdentifier, "headless"); return native({ buildResult: "The project built successfully." }); },
    });
    const result = await harness().tools.get("xcode_build").execute("build", {}, undefined, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(ctx.calls.map((call) => call.name), ["mcp__xcode__XcodeListWorkspaces", "mcp__xcode__XcodeOpenWorkspace", "mcp__xcode__BuildProject"]);
  });
}

test("an explicit project path reuses its existing headless workspace without reopening it", async () => {
  const ctx = context("/tmp/App", {
    XcodeListWorkspaces: () => native([{ workspaceIdentifier: "headless", workspacePath: "/tmp/App/App.xcodeproj" }]),
    BuildProject: (args) => { assert.equal(args.workspaceIdentifier, "headless"); return native({ buildResult: "The build succeeded" }); },
  });
  await harness().tools.get("xcode_build").execute("build", { workspaceIdentifier: "/tmp/App/App.xcodeproj" }, undefined, undefined, ctx);
  assert.equal(ctx.calls.length, 2);
});

test("a missing local project never builds an unrelated open workspace", async (t) => {
  const root = await temporary(t);
  const ctx = context(root, {
    XcodeListWorkspaces: () => native([{ workspaceIdentifier: "wrong", workspacePath: "/Other/Other.xcodeproj" }]),
    BuildProject: () => { throw new Error("Must not build an unrelated workspace"); },
  });
  await assert.rejects(harness().tools.get("xcode_build").execute("build", {}, undefined, undefined, ctx), /No matching Xcode/);
  assert.equal(ctx.calls.length, 1);
});

test("a build checks the active scheme and reports drift without retrying", async () => {
  let scheme = "App";
  const ctx = context("/tmp/App", {
    XcodeListSchemes: () => native({ activeSchemeName: scheme }),
    BuildProject: () => { scheme = "CustomNotification"; return native({ buildResult: "The build succeeded" }); },
  });
  const result = await harness().tools.get("xcode_build").execute("build", { workspaceIdentifier: "workspace" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content.map((block: any) => block.text).join("\n"), /App → CustomNotification/);
  assert.equal(ctx.calls.filter((call) => call.name.endsWith("BuildProject")).length, 1);
});

test("an explicit scheme is selected before building and never forwarded as a native build argument", async () => {
  let scheme = "CustomNotification";
  const ctx = context("/tmp/App", {
    XcodeSwitchScheme: (args) => { scheme = args.schemeName; return native({ activeSchemeName: scheme }); },
    XcodeListSchemes: () => native({ activeSchemeName: scheme }),
    BuildProject: (args) => { assert.deepEqual(args, { workspaceIdentifier: "workspace" }); return native({ buildResult: "The build succeeded" }); },
  });
  const result = await harness().tools.get("xcode_build").execute("build", { workspaceIdentifier: "workspace", schemeName: "App" }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.workflowContext.schemeName, "App");
});

test("a scheme switch that did not take effect prevents the build", async () => {
  const ctx = context("/tmp/App", {
    XcodeSwitchScheme: () => native({ activeSchemeName: "Wrong" }),
    XcodeListSchemes: () => native({ activeSchemeName: "Wrong" }),
    BuildProject: () => { throw new Error("Must not build"); },
  });
  await assert.rejects(harness().tools.get("xcode_build").execute("build", { workspaceIdentifier: "workspace", schemeName: "App" }, undefined, undefined, ctx), /did not select scheme/);
});

function summary(startedAt: number) {
  return { title: "Test - App", result: "Passed", totalTestCount: 1, passedTests: 1,
    failedTests: 0, skippedTests: 0, startTime: startedAt / 1000, finishTime: Date.now() / 1000 };
}

async function bundle(root: string, path = "Run.xcresult") {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "Info.plist"), "fixture");
  return directory;
}

test("verifies fresh result bundles and rejects stale, wrong-scheme, failed and skipped runs", async (t) => {
  const root = await temporary(t);
  const path = await bundle(root);
  const startedAt = Date.now();
  assert.equal((await verifyXcodeTestBundle(path, startedAt, "App", async () => summary(startedAt))).path, path);
  for (const changed of [
    { startTime: (startedAt - 60_000) / 1000 }, { title: "Test - Wrong" },
    { result: "Failed", failedTests: 1 }, { skippedTests: 1 }, { totalTestCount: 0 },
  ]) await assert.rejects(verifyXcodeTestBundle(path, startedAt, "App", async () => ({ ...summary(startedAt), ...changed })));
});

test("recovers a uniquely named original when Xcode exports an incomplete bundle", async (t) => {
  const root = await temporary(t);
  const exported = join(root, "exports/Run.xcresult");
  await mkdir(exported, { recursive: true });
  const original = await bundle(root, "DerivedData/App-hash/Logs/Test/Run.xcresult");
  const startedAt = Date.now();
  const verified = await verifyXcodeTestBundle(exported, startedAt, "App", async (path) => {
    assert.equal(path, original); return summary(startedAt);
  }, join(root, "DerivedData"));
  assert.equal(verified.path, original);
});

test("does not guess between multiple backing bundles or accept an unfinished export", async (t) => {
  const root = await temporary(t);
  const exported = join(root, "exports/Run.xcresult");
  await mkdir(exported, { recursive: true });
  const rootData = join(root, "DerivedData");
  const reader = async () => summary(Date.now());
  await assert.rejects(verifyXcodeTestBundle(exported, Date.now(), "App", reader, rootData), /no unique finalized/);
  await bundle(rootData, "First/Logs/Test/Run.xcresult");
  await bundle(rootData, "Second/Logs/Test/Run.xcresult");
  await assert.rejects(verifyXcodeTestBundle(exported, Date.now(), "App", reader, rootData), /no unique finalized/);
});

test("verified test wrapper checks selection, coverage, plan, and an actual fresh bundle", async (t) => {
  const root = await temporary(t);
  const path = await bundle(root);
  const selected = { targetName: "AppTests", testIdentifier: "Suite/test()" };
  let scheme = "Old";
  let plan = "OldPlan";
  let startedAt = 0;
  const ctx = context(root, {
    XcodeSwitchScheme: (args) => { scheme = args.schemeName; return native({ activeSchemeName: scheme }); },
    XcodeSwitchTestPlan: (args) => { plan = args.testPlanName; return native({ activeTestPlanName: plan }); },
    XcodeListSchemes: () => native({ activeSchemeName: scheme }),
    XcodeListTestPlans: () => native({ activeTestPlanName: plan }),
    RunSomeTests: (args) => {
      assert.deepEqual(args.tests, [selected]);
      startedAt = Date.now();
      return native({ schemeName: scheme, activeTestPlanName: plan, counts: { total: 1, passed: 1, failed: 0, notRun: 0 },
        results: [{ targetName: selected.targetName, identifier: selected.testIdentifier, state: "Passed" }], xcresultBundlePath: path });
    },
  });
  const { tools } = harness(async (command: string, args: string[]) => {
    assert.equal(command, "xcrun");
    assert.deepEqual(args, ["xcresulttool", "get", "test-results", "summary", "--path", path]);
    return { code: 0, stdout: JSON.stringify(summary(startedAt)), stderr: "", killed: false };
  });
  const result = await tools.get("xcode_test").execute("test", { workspaceIdentifier: "workspace", schemeName: "App", testPlanName: "Plan", tests: [selected] }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.verified, true);
  assert.equal(result.structuredContent.verifiedBundlePath, path);
});

test("verified test wrapper rejects missing requested tests and wrong-plan results without rerunning", async () => {
  const ctx = context("/tmp/App", {
    XcodeListTestPlans: () => native({ activeTestPlanName: "Plan" }),
    RunSomeTests: () => native({ activeTestPlanName: "Wrong", counts: { total: 1, failed: 0, notRun: 0 }, results: [] }),
  });
  const result = await harness().tools.get("xcode_test").execute("test", {
    workspaceIdentifier: "workspace", tests: [{ targetName: "AppTests", testIdentifier: "Suite/test()" }],
  }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.verified, false);
  assert.match(result.content[0].text, /Wrong/);
  assert.match(result.content[0].text, /Requested test/);
  assert.equal(ctx.calls.filter((call) => call.name.endsWith("RunSomeTests")).length, 1);
});

test("verified test wrapper rejects transport-successful runs without result bundles", async () => {
  const ctx = context("/tmp/App", { RunAllTests: () => native({ counts: { total: 1, passed: 1, failed: 0, notRun: 0 } }) });
  const result = await harness().tools.get("xcode_test").execute("test", { workspaceIdentifier: "workspace" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no result bundle/);
});
