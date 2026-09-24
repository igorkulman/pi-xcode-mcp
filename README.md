# pi-xcode-mcp

Connect [Pi](https://pi.dev) to **Xcode's built-in MCP server** so Pi can render SwiftUI previews, use Xcode project context, build and test through either the Xcode app or Xcode 27's headless service, inspect diagnostics, search Apple documentation, and run Swift snippets.

The primary goal is simple: **ask Pi to render a SwiftUI preview and inspect the actual screenshot**.

## Highlights

- First-class `xcode_render_preview` tool for SwiftUI preview screenshots.
- Automatically reads Xcode's `previewSnapshotPath` and attaches the image to Pi.
- Automatically resolves Xcode 27 `workspaceIdentifier` values from the workspace matching Pi's current directory.
- Mirrors Xcode's native MCP tools into Pi as `xcode_*` tools.
- Adds `xcode_build`, a convenience build wrapper that fetches logs and Issue Navigator diagnostics on failure.
- Preserves MCP text, structured content, resources, and image results.
- Auto-connects to either a running Xcode app or Xcode 27's headless MCP service.

## Requirements

- macOS
- Xcode 27 or later
- Pi installed
- Either an open Xcode project/workspace or a running headless MCP service

Check that Apple's MCP bridge is available:

```bash
xcrun --find mcpbridge
```

If this fails, make sure `xcode-select` points to the full Xcode app, not just Command Line Tools:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
```

## Enable Xcode MCP

### Xcode app

In Xcode:

1. Open **Xcode > Settings > Intelligence**.
2. Enable **Model Context Protocol / Xcode Tools**.
3. Open your project or workspace in Xcode.
4. When Xcode asks to allow the external MCP connection, click **Allow**.

### Headless Xcode 27

Xcode 27 can expose the same tools without running the Xcode UI. Enabling the service changes a system permission and requires administrator approval; this extension never enables it or runs `sudo` automatically.

Enable it once, then start it:

```bash
sudo xcrun mcp-server enable
xcrun mcp-server start
xcrun mcp-server status
```

Keep the default per-agent approval mode. Do not use `--unsafe-always-allow-all-agents` unless you understand that it grants every local process access to every reachable Xcode project.

In headless mode, the first `XcodeOpenWorkspace` call asks you to approve the agent and project folder. The extension inherits `DEVELOPER_DIR`, so you can target a non-default Xcode installation without changing the global `xcode-select` selection:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```

## Installation

### Install from npm

```bash
pi install npm:pi-xcode-mcp
```

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

## Quick start: render a SwiftUI preview

1. Open your app or package in Xcode, or start Xcode 27's headless MCP service.
2. Open Pi from the same project/workspace directory.
3. In headless mode, ask Pi to open the project through Xcode MCP if it is not already active.
4. Ask Pi:

```text
Render the SwiftUI preview in DeviceListView and tell me what you see.
```

Pi should use `xcode_render_preview`, resolve the matching Xcode workspace, call Xcode MCP's `RenderPreview`, read the generated preview image from `previewSnapshotPath`, and inspect the screenshot.

If the view file has multiple previews, ask for a specific preview index:

```text
Render preview index 1 in DeviceListView.
```

## Tools

Common tools exposed by this package:

| Tool | Purpose |
| --- | --- |
| `xcode_render_preview` | Render a SwiftUI preview screenshot and return the image to Pi. |
| `xcode_build` | Build through Xcode MCP and fetch build logs/diagnostics on failure. |
| `xcode_build_project` | Direct mirror of Xcode MCP's `BuildProject`. |
| `xcode_get_build_log` | Inspect Xcode build errors and warnings. |
| `xcode_run_all_tests` / `xcode_run_some_tests` | Run tests through Xcode. |
| `xcode_get_test_list` | Discover tests in the active scheme/test plan. |
| `xcode_documentation_search` | Search Apple documentation and WWDC transcript context. |
| `xcode_run_code_snippet` | Run Swift snippets in source-file context. |
| `xcode_read`, `xcode_update`, `xcode_grep`, `xcode_glob`, ... | Project-aware file operations through Xcode. |
| `xcode_mcp_call` | Schema-validated fallback for calling any Xcode MCP tool by MCP name. |

The extension resolves `workspaceIdentifier` from Xcode 27's `XcodeListWorkspaces` in both app-based and headless sessions. It prefers the workspace path that best matches Pi's current working directory and reports ambiguity instead of choosing an unrelated workspace. Use the mirrored `xcode_open_workspace` tool first when no workspace is open.

## Commands

Inside Pi:

```text
/xcode-mcp-status
/xcode-mcp-connect
/xcode-mcp-list-tools
/xcode-mcp-disconnect
```

## Autoconnect behavior

By default, the extension auto-connects only when:

- the current working directory looks like an Xcode project/workspace or Swift package, and
- either the Xcode app or Xcode 27's headless MCP service is already running.

The extension checks `xcrun mcp-server status` only when Xcode is closed. It does not enable or start the headless service, and it avoids starting `xcrun mcpbridge` in unrelated projects.

Force autoconnect everywhere:

```bash
export XCODE_MCP_AUTOCONNECT=1
```

Disable autoconnect completely:

```bash
export XCODE_MCP_AUTOCONNECT=0
```

Manual connection is always available with:

```text
/xcode-mcp-connect
```

or by asking Pi to use `xcode_mcp_connect`.

## Example workflows

### Verify a SwiftUI change visually

```text
I changed DeviceListView. Render its SwiftUI preview and compare the screenshot with the expected layout.
```

Pi can call `xcode_render_preview`, receive the rendered image, and reason about the actual UI instead of relying only on source code or build output.

### Build and inspect errors

```text
Build the active Xcode scheme and summarize any errors.
```

Pi can call `xcode_build`, which builds through the matching Xcode workspace, resolves its workspace identifier when required, and fetches `GetBuildLog` plus Issue Navigator diagnostics when the build fails. This is usually preferable to shell `xcodebuild` when Xcode MCP is available.

### Search Apple docs

```text
Search Apple documentation for the current NavigationSplitView API.
```

Pi can call `xcode_documentation_search`.

## Troubleshooting

### No tools discovered

For the Xcode app, make sure:

- Xcode is running with a project/workspace open.
- Xcode MCP is enabled in **Xcode > Settings > Intelligence**.
- You allowed the MCP connection dialog.

For headless Xcode 27, check:

```bash
xcrun mcp-server status
```

The output should report `Permission: enabled` and `mcp-server: running`. If no workspace is active after connecting, ask Pi to call `xcode_open_workspace` for the project or workspace in the current directory and approve the folder prompt.

Then run:

```text
/xcode-mcp-connect
```

### `xcrun: error: unable to find utility "mcpbridge"`

Your command-line tools are probably selected instead of the full Xcode app:

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
xcrun --find mcpbridge
```

### Xcode asks for permission repeatedly

This is controlled by Xcode. Click **Allow** in the Xcode prompt. Future Xcode versions may improve this flow.

### Preview rendering times out

Open the file in Xcode and make sure previews can render there. Large projects may need a first build before previews become available through MCP.

### Preview renders but Pi cannot see the screenshot

`xcode_render_preview` reads the local file returned by Xcode MCP as `previewSnapshotPath` and attaches it as an image result. If the snapshot file has already been deleted or cannot be read, the tool result will include the snapshot path and the read error.

### Multiple Xcode workspaces are open

If Pi cannot choose a unique workspace, the tool result lists the open `workspaceIdentifier` values. Re-run the tool with the correct identifier, or run Pi from the directory that matches the intended Xcode workspace.

### A generic MCP call has invalid arguments

`xcode_mcp_call` validates arguments against the schema advertised by Xcode before invoking the tool. Prefer the specific mirrored `xcode_*` tool because its argument schema is visible directly to the model. Validation errors list required and supported argument names instead of forwarding guessed arguments to Xcode.

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

Try the package locally:

```bash
pi --no-extensions -e .
```

Pack without publishing:

```bash
npm pack --dry-run
```

## Publishing and pi.dev

This package is discoverable by Pi's package gallery because `package.json` includes the `pi-package` keyword and a `pi` manifest.

Publish to npm:

```bash
npm publish
```

Then users can install it with:

```bash
pi install npm:pi-xcode-mcp
```

## Security

Pi extensions run with your local user permissions. This extension starts Apple's `xcrun mcpbridge` and exposes Xcode's MCP tools to the active Pi model. It detects but never enables or starts Xcode 27's headless service. Only use it with models and projects you trust, and prefer headless mode's per-agent and per-folder approvals over unsafe global access.

## License

MIT
