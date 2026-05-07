# CLAUDE.md — Terminal Reader extension

VSCode extension that exposes this VSCode window's terminals + problems to Claude over a local MCP server. The extension hosts a named-pipe JSON-RPC server; a small bridge script (`bridge/mcp-bridge.js`) is what Claude actually spawns — it discovers the running VSCode and proxies MCP stdio to the pipe.

## Build / run

- `npm run compile` — esbuild bundle to `dist/extension.js`
- `npm run lint` — `tsc --noEmit` type check
- `F5` in VSCode — launches Extension Development Host

## Key invariants

- The bridge writes nothing to stdout except MCP JSON-RPC frames. All logs go to stderr (gated by `VSCODE_TR_DEBUG`).
- Endpoint files live in `%APPDATA%\vscode-terminal-reader\windows\<extensionHostPid>.json`. They include an auth token; the bridge sends `auth` before any tool call.
- Terminal output capture only works when shell integration is active. Document this; do not pretend otherwise.
- ANSI stripping is applied on read, not on write — keeps the raw stream available if a future tool wants it.

## Things to add (deliberately deferred)

- DebugAdapterTrackerFactory for debug console
- onDidStartTaskProcess / onDidEndTaskProcess for task output
- vscode.workspace.tunnels / onDidChangeTunnels for ports
- Output channels (no public list API — opt-in by name)
- `terminal_run` (gated behind a setting; off by default)
