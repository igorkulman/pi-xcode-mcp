# pi-xcode-mcp

Connect [Pi](https://pi.dev) to **Xcode's built-in MCP server** using Pi 0.99's native MCP client, with Xcode-specific wrappers for SwiftUI previews, workspace selection, builds, and diagnostics.

> **Requires Pi 0.99.0 or later.** Earlier Pi versions do not provide the native MCP APIs used by this package.

The primary goal is simple: **ask Pi to render a SwiftUI preview and inspect the actual screenshot**.

## Why this package still exists

Pi now owns the generic MCP transport and lifecycle. This package adds the Xcode-specific behavior that raw MCP configuration does not provide:

- Registers `xcrun mcpbridge` through `pi.registerMcpServer()`.
- Adds `xcode_render_preview`, which reads Xcode's `previewSnapshotPath` and attaches the image to Pi.
- Automatically resolves `workspaceIdentifier` from the workspace matching Pi's current directory, or opens an unambiguous local project through the headless service. Never selects an unrelated open project.
- Adds `xcode_build`, which fetches build logs and, when Xcode advertises the tool, Issue Navigator diagnostics on failure.
- Adds `xcode_test`, which verifies requested-test coverage and a fresh, readable result bundle instead of trusting transport success alone.
- Checks the active scheme/test plan before and after builds, tests, and previews, and reports unexpected changes without automatically rerunning the operation.
- Treats logical build, test, and preview failures as failed Pi tool results even when the MCP transport itself succeeded.
- Keeps the raw Xcode MCP tools available through Pi's token-efficient `codemode` exposure.

Pi's built-in `/mcp` interface handles connection status, errors, reconnecting, enabling, and disabling the server.

## Requirements

- macOS
- Pi 0.99.0 or later
- Xcode 27 or later
- Either an open Xcode project/workspace or a running headless MCP service

Check that Apple's MCP bridge is available:

```bash
xcrun --find mcpbridge
```

If this fails, make sure `xcode-select` points to the full Xcode app rather than Command Line Tools:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
```

## Enable Xcode MCP

### Xcode app

1. Open **Xcode > Settings > Intelligence**.
2. Enable **Model Context Protocol / Xcode Tools**.
3. Open your project or workspace in Xcode.
4. When Xcode asks to allow the external MCP connection, click **Allow**.

### Headless Xcode 27

Xcode 27 can expose the same tools without running the Xcode UI. Enabling the service changes a system permission and requires administrator approval; this package never enables it or runs `sudo` automatically.

Enable it once, then start it:

```bash
sudo xcrun mcp-server enable
xcrun mcp-server start
xcrun mcp-server status
```

Keep the default per-agent approval mode. Do not use `--unsafe-always-allow-all-agents` unless you understand that it grants every local process access to every reachable Xcode project.

In headless mode, the first `XcodeOpenWorkspace` call asks you to approve the agent and project folder. The MCP server inherits `DEVELOPER_DIR`, so you can target a non-default Xcode installation:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

## Installation

### Selected project only

This is the recommended setup for selectively enabling Xcode MCP:

```bash
cd /path/to/project
pi install -l npm:pi-xcode-mcp
```

The project-local Pi settings load the package only in that project. The package then registers its native MCP server for that session; a separate `.pi/mcp.json` entry is not required.

### Global installation

```bash
pi install npm:pi-xcode-mcp
```

Use global installation only if you want Pi to attempt the Xcode MCP connection in every project where the package is loaded.

If Pi is already running, reload resources:

```text
/reload
```

### Install from a local checkout

```bash
git clone https://github.com/igorkulman/pi-xcode-mcp.git
cd pi-xcode-mcp
pi install .
```

### Try without installing

```bash
pi -e /absolute/path/to/pi-xcode-mcp
```

## Quick start

1. Open your app or package in Xcode, or start Xcode's headless MCP service.
2. Open Pi from the same project/workspace directory.
3. Run `/mcp` and confirm that the `xcode` server is connected.
4. No project needs to be open in the Xcode UI when the headless service is running. The wrappers reuse a matching workspace or open the nearest unambiguous `.xcworkspace`/`.xcodeproj` automatically. Approve the project folder if macOS asks.
5. Ask Pi:

```text
Render the SwiftUI preview in DeviceListView and tell me what you see.
```

Pi uses `xcode_render_preview`, resolves the matching workspace, calls Xcode's native `RenderPreview` MCP tool, reads the generated snapshot, and inspects the attached image.

If the source file contains multiple previews:

```text
Render preview index 1 in DeviceListView.
```

## Tools

### Xcode-specific wrappers

| Tool | Purpose |
| --- | --- |
| `xcode_render_preview` | Render a SwiftUI preview, resolve its workspace, and attach the screenshot. |
| `xcode_build` | Build through Xcode MCP, check scheme stability, and fetch diagnostics on failure. |
| `xcode_test` | Run selected tests or the active plan, verify workflow context and execution, and reject incomplete or stale results. |
| `xcode_mcp_call` | Compatibility fallback that accepts an MCP name, native Pi tool name, or legacy `xcode_*` alias. |

### Native Xcode MCP tools

Xcode's advertised tools are registered by Pi as `mcp__xcode__<tool>`, for example:

- `mcp__xcode__BuildProject`
- `mcp__xcode__RunAllTests`
- `mcp__xcode__RunSomeTests`
- `mcp__xcode__DocumentationSearch`
- `mcp__xcode__XcodeOpenWorkspace`
- `mcp__xcode__XcodeListWorkspaces`

They use `codemode` exposure by default, keeping the complete Xcode tool set out of the model's direct tool declarations while remaining callable by Pi and by this package's wrappers.

The available tools are determined by the installed Xcode version. Inspect them with `/mcp` rather than relying on a fixed package-maintained mirror.

## Example workflows

### Verify a SwiftUI change visually

```text
I changed DeviceListView. Render its SwiftUI preview and compare the screenshot with the expected layout.
```

### Build and inspect errors

```text
Build the active Xcode scheme and summarize any errors.
```

`xcode_build` builds through the matching workspace and retrieves `GetBuildLog` plus Issue Navigator diagnostics when those tools are advertised by the installed Xcode version. Its optional `schemeName` selects the requested scheme before the build; otherwise the current scheme is used. The active scheme is checked again afterward when Xcode advertises scheme-inspection tools.

### Run verified tests

```text
Run SeatFamilyProductRemovalTests using scheme Debug - Evenflo and test plan EvenfloSensorSafe.
```

Use `xcode_test` with optional `schemeName`, `testPlanName`, and `workspaceIdentifier`. Supply `tests: [{ targetName, testIdentifier }]` using identifiers from `GetTestList`, or omit `tests` to run the active plan.

The wrapper rejects failed, cancelled, empty, partially unexecuted, skipped, stale, wrong-context, or missing-requested-test runs. It reads the result bundle with `xcrun xcresulttool`; this inspects results and never reruns tests through shell `xcodebuild`. No automatic retry occurs.

Xcode 27 sometimes exports an unfinished `.xcresult` copy without `Info.plist`. When this happens, the wrapper looks for a unique finalized original with the identical bundle name under `~/Library/Developer/Xcode/DerivedData`, then verifies its scheme and execution timestamps. It never repairs the exported copy. If the original cannot be identified or read (including custom DerivedData locations), the run is reported as unverified rather than successful.

### Search Apple documentation

```text
Use Xcode MCP to search Apple documentation for the current NavigationSplitView API.
```

Pi can call the native `DocumentationSearch` tool through `codemode`.

## MCP management

Use Pi's built-in interface:

```text
/mcp
/mcp reconnect xcode
```

From the shell, project and global configured servers can be inspected with:

```bash
pi mcp list
```

The `xcode` server appears as extension-provided because this package registers it at runtime. Pi's shell command does not load extensions, so use `/mcp` inside a Pi session to inspect this package's registration.

If a project `.pi/mcp.json` defines another server named `xcode`, that configured entry takes precedence over this package's registration.

## Troubleshooting

### The xcode server does not connect

Run `/mcp`, select `xcode`, and inspect the complete connection error. Also verify:

```bash
xcrun --find mcpbridge
xcrun mcp-server status
```

For the Xcode app, make sure Xcode is running, the project is open, Xcode MCP is enabled under **Settings > Intelligence**, and the connection prompt was approved.

### No workspace is open

With the headless service already running, the wrappers find the nearest unambiguous local project and call `XcodeOpenWorkspace` automatically; the Xcode UI does not need an open project. Discovery stops at a repository/worktree boundary and prefers a single `.xcworkspace` over `.xcodeproj` directories. If several candidates exist, pass `workspaceIdentifier` with the desired project/workspace path. Native MCP calls made directly still require their workspace context.

The extension does not enable or start the headless service, grant folder permissions, or invoke `sudo`.

### Preview rendering times out

Open the file in Xcode and make sure its preview can render there. Large projects may need an initial build before previews become available through MCP. The package configures a 120-second MCP request timeout.

### Preview renders but Pi cannot see the screenshot

`xcode_render_preview` reads the local `previewSnapshotPath` returned by Xcode and attaches it as an image. If Xcode removes the temporary file before it can be read, the result includes the path and read error.

### Multiple Xcode workspaces are open

The wrapper prefers the workspace path matching Pi's current directory and prefers its headless identifier when both headless and UI entries exist. It never falls back to a sole unrelated project. You can pass `workspaceIdentifier` as an identifier or a `.xcodeproj`/`.xcworkspace` path; paths are resolved to an existing identifier or opened through MCP.

### Scheme unexpectedly changes

Pass `schemeName` to `xcode_build`, `xcode_test`, or `xcode_render_preview`, and `testPlanName` to `xcode_test` when a specific plan is required. The wrappers select that context immediately before execution and check it afterward. Results from another scheme/plan, or changes during execution, are flagged as unverified. Inspect the recorded `workflowContext` and Xcode logs instead of treating a successful transport response as proof of the intended build or test run.

## Development

Install dependencies:

```bash
npm install
```

Run tests and type-check:

```bash
npm test
npm run typecheck
```

Try the package locally with Pi's built-in MCP support enabled:

```bash
pi --no-extensions -e builtin:mcp -e .
```

Pack without publishing:

```bash
npm pack --dry-run
```

## Security

Pi extensions run with your local user permissions. This package asks Pi's native MCP client to start Apple's `xcrun mcpbridge`, and the active model can call tools exposed by Xcode. Only use it with models and projects you trust, and prefer headless mode's per-agent and per-folder approvals over unsafe global access.

The package never enables or starts Xcode's headless service and never invokes `sudo`.

## License

MIT
