# pi-xcode-mcp

Connect [Pi](https://pi.dev) to **Xcode's built-in MCP server** so Pi can use Xcode project context, build/test actions, diagnostics, Apple documentation search, Swift snippets, and SwiftUI preview screenshots.

This package installs a Pi extension that:

- starts Xcode MCP through `xcrun mcpbridge`
- speaks MCP over stdio
- discovers Xcode's native MCP tools automatically
- mirrors them into Pi as `xcode_*` tools
- preserves MCP image results, so SwiftUI previews can be shown to Pi

## What you get

Once connected, Pi can use Xcode tools such as:

- `xcode_render_preview` — capture a SwiftUI preview screenshot
- `xcode_build_project` — build the active scheme
- `xcode_get_build_log` — inspect build errors and warnings
- `xcode_run_all_tests` / `xcode_run_some_tests` — run tests through Xcode
- `xcode_documentation_search` — search Apple documentation and WWDC transcript context
- `xcode_execute_snippet` — run Swift snippets in source-file context
- `xcode_read`, `xcode_update`, `xcode_grep`, `xcode_glob`, ... — project-aware file operations through Xcode

The extension also provides fallback tools:

- `xcode_mcp_connect` — connect/reconnect and discover tools
- `xcode_mcp_call` — call any Xcode MCP tool by MCP name

## Requirements

- macOS
- Xcode 26.3 or later
- Pi installed
- an Xcode project/workspace open in Xcode
- Xcode MCP enabled in Xcode settings

Check that the bridge is available:

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

You can force autoconnect everywhere:

```bash
export XCODE_MCP_AUTOCONNECT=1
```

You can disable autoconnect completely:

```bash
export XCODE_MCP_AUTOCONNECT=0
```

Manual connection is always available with:

```text
/xcode-mcp-connect
```

or by asking Pi to use `xcode_mcp_connect`.

## Example workflows

### Render a SwiftUI preview

Ask Pi:

```text
Render the SwiftUI previews in DeviceListView and tell me what you see.
```

Pi can call `xcode_render_preview`, receive the screenshot, and inspect the rendered UI.

### Build and inspect errors

```text
Build the active Xcode scheme and summarize any errors.
```

Pi can call `xcode_build_project`, then `xcode_get_build_log` if the build fails.

### Search Apple docs

```text
Search Apple documentation for the current NavigationSplitView API.
```

Pi can call `xcode_documentation_search`.

## Troubleshooting

### No tools discovered

Make sure:

- Xcode is running
- a project/workspace is open in Xcode
- Xcode MCP is enabled in **Xcode > Settings > Intelligence**
- you allowed the MCP connection dialog

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
