# CLAUDE.md — Terminal Reader extension

VSCode extension that exposes this VSCode window's terminals + problems to Claude over a local MCP server. The extension hosts a named-pipe JSON-RPC server; a small bridge script (`bridge/mcp-bridge.js`) is what Claude actually spawns — it discovers the running VSCode and proxies MCP stdio to the pipe.

## Build / run

- `npm run compile` — esbuild bundle to `dist/extension.js`
- `npm run lint` — `tsc --noEmit` type check
- `F5` in VSCode — launches Extension Development Host

## Tools exposed (MCP)

`terminal_list`, `terminal_read`, `terminal_read_all`, `terminal_state`, `terminal_interrupt`, `terminal_clear`, `problems_list`, `problems_summary`. See [README.md](README.md) for the canonical user-facing docs (formats, grep, OSC 633, examples).

`terminal_read` returns three formats: `text` (default, compact), `json` ({lineNumber,text}[]), `raw` (untouched stream). Raw stream is kept in a 1 MiB-per-terminal rolling buffer alongside the line buffer.

## Key invariants

- The bridge writes nothing to stdout except MCP JSON-RPC frames. All logs go to stderr (gated by `VSCODE_TR_DEBUG`).
- Endpoint files live in `%APPDATA%\vscode-terminal-reader\windows\<extensionHostPid>.json`. They include an auth token; the bridge sends `auth` before any tool call.
- Terminal output capture only works when shell integration is active. Document this; do not pretend otherwise.
- ANSI stripping is applied on read for `text`/`json` formats; `raw` is preserved verbatim so callers can parse OSC 633 themselves.
- Line numbers are stable, monotonic, 1-based across the buffer's whole lifetime — never reused, never reset (not even by `terminal_clear`). This means a `range` query for evicted line numbers cleanly returns nothing instead of returning stale content under the same numbers.
- MCP registration writes user scope into `~/.claude.json` (top-level `mcpServers`), honouring `CLAUDE_CONFIG_DIR`. Do NOT write to `~/.claude/mcp.json` — that path is not part of Claude Code's spec. See the user-level `claude-code-mcp` skill for the full reference (scopes, JSON shape, restart semantics).
- "Restart Claude Code" for users of the VSCode extension means **Reload Window** (Developer: Reload Window). For CLI users it's `/exit` + re-run `claude`. Match user-facing strings to the flavor in use.
- The status bar shows a single icon (`$(terminal)` / `$(warning)` / `$(error)`) — no version text. Diagnostics live in the tooltip and click handler.

## Things to add (deliberately deferred)

- `terminal_run` gated by Claude Code's existing `permissions.allow` rules — see [issue #3](https://github.com/davwright/vscode-terminal-reader/issues/3) for the spec
- DebugAdapterTrackerFactory for debug console
- onDidStartTaskProcess / onDidEndTaskProcess for task output
- vscode.workspace.tunnels / onDidChangeTunnels for ports
- Output channels (no public list API — opt-in by name)
