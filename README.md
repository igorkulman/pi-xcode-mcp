# pi-xcode-mcp

Connect [Pi](https://pi.dev) to **Xcode's built-in MCP server** so Pi can render SwiftUI previews, use Xcode project context, build and test through the running Xcode instance, inspect diagnostics, search Apple documentation, and run Swift snippets.

The primary goal is simple: **ask Pi to render a SwiftUI preview and inspect the actual screenshot**.

## Highlights

- First-class `xcode_render_preview` tool for SwiftUI preview screenshots.
- Automatically reads Xcode's `previewSnapshotPath` and attaches the image to Pi.
- Automatically resolves Xcode's `tabIdentifier` from open Xcode windows whenever possible.
- Mirrors Xcode's native MCP tools into Pi as `xcode_*` tools.
- Adds `xcode_build`, a convenience build wrapper that fetches logs and Issue Navigator diagnostics on failure.
- Preserves MCP text, structured content, resources, and image results.

## Requirements

- macOS
- Xcode 26.3 or later
- Pi installed
- An Xcode project/workspace open in Xcode
- Xcode MCP enabled in Xcode settings

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

In Xcode:

1. Open **Xcode > Settings > Intelligence**.
2. Enable **Model Context Protocol / Xcode Tools**.
3. Open your project or workspace in Xcode.
4. When Xcode asks to allow the external MCP connection, click **Allow**.

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

1. Open your app or package in Xcode.
2. Open Pi from the same project/workspace directory.
3. Ask Pi:

```text
Render the SwiftUI preview in DeviceListView and tell me what you see.
```

Pi should use `xcode_render_preview`, resolve the open Xcode tab, call Xcode MCP's `RenderPreview`, read the generated preview image from `previewSnapshotPath`, and inspect the screenshot.

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
| `xcode_mcp_call` | Fallback for calling any Xcode MCP tool by MCP name. |

Xcode MCP tools often require an Xcode `tabIdentifier`. This extension resolves it automatically from `XcodeListWindows`, preferring the Xcode window whose workspace path best matches Pi's current working directory. If multiple windows are ambiguous, pass `tabIdentifier` explicitly in tool arguments.

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
- Xcode is already running.

This avoids starting `xcrun mcpbridge` in unrelated projects.

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

Pi can call `xcode_build`, which builds through the running Xcode instance, resolves the open Xcode tab automatically, and fetches `GetBuildLog` plus Issue Navigator diagnostics when the build fails. This is usually preferable to shell `xcodebuild` when Xcode MCP is available.

### Search Apple docs

```text
Search Apple documentation for the current NavigationSplitView API.
```

Pi can call `xcode_documentation_search`.

## Troubleshooting

### No tools discovered

Make sure:

- Xcode is running.
- A project/workspace is open in Xcode.
- Xcode MCP is enabled in **Xcode > Settings > Intelligence**.
- You allowed the MCP connection dialog.

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

### Multiple Xcode windows are open

If Pi cannot choose a unique Xcode tab, the tool result will list the open `tabIdentifier` values. Re-run the tool with the correct `tabIdentifier`, or run Pi from the directory that matches the open Xcode workspace.

## Development

Install dependencies:

```bash
npm install
```

Type-check:

```bash
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

Pi extensions run with your local user permissions. This extension starts Apple's `xcrun mcpbridge` and exposes Xcode's MCP tools to the active Pi model. Only use it with models and projects you trust.

## License

MIT
