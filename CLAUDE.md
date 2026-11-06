# CLAUDE.md — Terminal Reader extension

VSCode extension that exposes this VSCode window's terminals + problems to Claude over a local MCP server. The extension hosts a named-pipe JSON-RPC server; a small bridge script (`bridge/mcp-bridge.js`) is what Claude actually spawns — it discovers the running VSCode and proxies MCP stdio to the pipe.

## Build / run

- `npm run compile` — esbuild bundle to `dist/extension.js`
- `npm run lint` — `tsc --noEmit` type check
- `F5` in VSCode — launches Extension Development Host

## Tools exposed (MCP)

`terminal_list`, `terminal_read`, `terminal_read_all`, `terminal_state`, `terminal_run`, `terminal_wait`, `terminal_interrupt`, `terminal_clear`, `problems_list`, `problems_summary`, plus the embedded-browser surface: `browser_open`, `browser_navigate`, `browser_eval`, `browser_console_read`, `browser_dom_snapshot`, `browser_query_selector`, `browser_screenshot`, `browser_close`, `browser_status`. See [README.md](README.md) for the canonical user-facing docs (formats, grep, OSC 633, examples).

`terminal_read` returns three formats: `text` (default, compact), `json` ({lineNumber,text}[]), `raw` (untouched stream). Raw stream is kept in a 1 MiB-per-terminal rolling buffer alongside the line buffer.

## Key invariants

- The bridge writes nothing to stdout except MCP JSON-RPC frames. All logs go to stderr (gated by `VSCODE_TR_DEBUG`).
- The bridge's `initialize` response carries a server-level `instructions` string (`SERVER_INSTRUCTIONS` in [bridge/mcp-bridge.js](bridge/mcp-bridge.js)). Claude Code surfaces it as the server's "MCP Server Instructions" on connect. Its whole job is to push the model toward the event-driven control loop — `terminal_run({wait:true})` / `terminal_wait` blocking on a D-mark or `returnOnPattern`, re-arming the wait for jobs past the 5-min cap — instead of `terminal_state` sleep-polling. Keep it in sync with the `terminal_run`/`terminal_wait` tool descriptions in [src/McpHandlers.ts](src/McpHandlers.ts), which carry the same message at the point of use.
- Endpoint files live in `%APPDATA%\vscode-terminal-reader\windows\<extensionHostPid>.json`. They include an auth token; the bridge sends `auth` before any tool call.
- Terminal output capture only works when shell integration is active. Document this; do not pretend otherwise.
- ANSI stripping is applied on read for `text`/`json` formats; `raw` is preserved verbatim so callers can parse OSC 633 themselves.
- Line numbers are stable, monotonic, 1-based across the buffer's whole lifetime — never reused, never reset (not even by `terminal_clear`). This means a `range` query for evicted line numbers cleanly returns nothing instead of returning stale content under the same numbers.
- MCP registration writes user scope into `~/.claude.json` (top-level `mcpServers`), honouring `CLAUDE_CONFIG_DIR`. Do NOT write to `~/.claude/mcp.json` — that path is not part of Claude Code's spec. See the user-level `claude-code-mcp` skill for the full reference (scopes, JSON shape, restart semantics).
- "Restart Claude Code" for users of the VSCode extension means **Reload Window** (Developer: Reload Window). For CLI users it's `/exit` + re-run `claude`. Match user-facing strings to the flavor in use.
- The status bar shows a single icon (`$(terminal)` / `$(warning)` / `$(error)`) — no version text. Diagnostics live in the tooltip and click handler.
- Version-mismatch detection: bridge sends `clientVersion` in `auth`; extension also polls `<extensionPath>/package.json` every 30s. If a newer version than the running host appears, status flips to red `$(error)` with a "Reload window" prompt. Sticky for the host's lifetime — only a reload clears it. Version compare lives in [src/IpcServer.ts](src/IpcServer.ts) (`compareVersions`); it parses `MAJOR.MINOR.PATCH` and ignores pre-release tags.
- `terminal_run` with `wait:true` and `terminal_wait` block the MCP call until the shell-integration D-mark fires for the current command, a `returnOnPattern` regex matches a new line, or `timeoutMs` elapses. Default 60 s, hard cap 5 min ([src/McpHandlers.ts](src/McpHandlers.ts) `clampWaitTimeout`) — long enough for most builds/lints/tests, short enough that one tool call can't monopolise a Claude tool slot. Resolution is event-driven via `endWaiters` + `appendWaiters` arrays on each `TerminalEntry`; there is no polling loop. Shell integration off → `reason:'unsupported'` returned immediately, because OSC 633 D-marks are the only reliable end-of-command signal. Stderr/stdout are merged by the PTY before the extension sees the bytes — `returnOnPattern` matches the combined stream, not stderr specifically.

## terminal_run permissions — what's implemented vs deferred

`Permissions.ts` implements a **minimal subset** of [issue #3](https://github.com/davwright/vscode-terminal-reader/issues/3). It reads a single file: `<workspaceRoot>/.claude/settings.local.json`, on every call (no fs.watch), and applies `permissions.allow` / `permissions.deny`. Default-deny, deny-wins, compound commands split on `&&|;|||&|&|\n` and each subcommand evaluated independently. Bare `Bash` / `PowerShell` and `Bash(*)` / `PowerShell(*)` match everything. `:*` suffix is shorthand for ` *` (Claude Code grammar). PowerShell match is case-insensitive, Bash is case-sensitive.

Shell detection in `TerminalCapture.detectShell()`: reads `terminal.creationOptions.shellPath`, looks for `pwsh|powershell` → PowerShell, `bash|zsh|sh|fish` → Bash, falls back to platform default (PowerShell on win32, Bash elsewhere).

**Deferred from issue #3** — list lives at the top of [src/Permissions.ts](src/Permissions.ts) too:
- User-level (`~/.claude/settings.json`) and managed/policy settings layers
- `permissions.ask` rules (treated as deny — no UI to prompt through MCP)
- Process wrapper stripping (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `xargs`)
- Always-prompt wrapper exact-match enforcement (`watch`, `find -exec`, etc.)
- PowerShell alias canonicalisation (`gci` → `Get-ChildItem`)
- Read-only command auto-approve list (`ls`, `cat`, `grep`, …)
- Audit output channel — using stderr console logs instead
- `fs.watch` hot reload — re-reading on every call instead

If a future change adds any of these, drop the corresponding entry from this list AND from the comment block at the top of `Permissions.ts`. Both must agree.

## PreToolUse hook replay — terminal_run is not a side door

`terminal_run` runs **the user's `~/.claude/settings.json` `PreToolUse` hooks first**, before the workspace allow/deny check from `Permissions.ts`. Without this, Claude could escape the git/python guards by routing commands through `mcp__vscode-reader__terminal_run` (which doesn't match the user's `"Bash"` / `"PowerShell"` matchers). Ordering: hook block > permission deny > permission allow.

Implementation lives in [src/HookRunner.ts](src/HookRunner.ts). The runner:

- Reads `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR`-aware, same precedent as [src/extension.ts:354](src/extension.ts#L354)) on every call — no cache, no `fs.watch`.
- Walks `hooks.PreToolUse`, matches `matcher` against the synthetic tool name (`Bash` or `PowerShell` per detected shell). Empty string and `"*"` match everything; otherwise treats matcher as a regex anchored with `^...$`.
- Spawns each matching `type: "command"` shell-form hook with the Claude Code-compatible JSON payload (`session_id`, `hook_event_name: "PreToolUse"`, `tool_name`, `tool_input.command`). The payload is written to a temp file and the hook's stdin is **redirected from that file** (`bash -c '"<bash>" "<script>" < tmp.json'`), not piped through Node's spawn-stdin — piping wedged two ways on Windows (jq's "writing output failed", and cmd.exe holding stdout open past bash's exit so `close` never fired). Tilde-prefixed paths are expanded to `os.homedir()` before spawn; the temp file is unlinked after the wait.
  - **Bash is resolved explicitly, never spawned bare.** On Windows, `spawn('bash')` resolves to `C:\Windows\System32\bash.exe` — the WSL launcher — not Git Bash; with no usable WSL distro it hangs, so every hook ran to timeout. `findBashExe()` picks `%PROGRAMFILES%\Git\bin\bash.exe` (and known fallbacks), and the **inner** `bash` token is resolved too (a bare `bash` inside `bash -c` re-trips the same hijack). Cached for the host's lifetime. This was the entire "hooks always time out" root cause.
- Translates the hook's exit code: 2 → block (stderr is the reason, trimmed to 500 chars); 0 + `{decision:"block"}` JSON → block; everything else → allow + log first line of stderr.
- Honours each hook's `timeout` (seconds), default 10, hard cap 30. Sequential within a matched group; short-circuits on the first block.

Deferred (mirrored in the comment block at the top of `HookRunner.ts` — keep both in sync):
- `type: "http" | "mcp_tool" | "prompt" | "agent"` (one-line warning, treat as allow)
- Exec-form `command` hooks (`args` present)
- `fs.watch` hot reload — re-read on every call

## Hooks

This extension installs no hooks. The guards (git writes, python, ev) live in `claude-git-guard.exe` from c:/git/tools/githooks.

The status bar shows a separate `$(shield)` icon (gold/yellow) whenever any `PreToolUse` hooks are armed for `Bash` or `PowerShell`. Click → "Show active PreToolUse hooks" command lists them. Refreshed every 30s.

## Embedded browser surface — what's implemented vs deferred

The `browser_*` tools talk to a **Chromium spawned by the extension** (Chrome or Edge — whichever is installed) over **raw Chrome DevTools Protocol on `127.0.0.1:<random port>`**. There is no public VSCode API for the new "Integrated Browser" (`editor-browser` debug type) — [microsoft/vscode#258125](https://github.com/microsoft/vscode/issues/258125) was closed as out-of-scope — so we spawn our own. The browser lifetime is tied to the extension host: when the host dies, the child Chrome dies with it (`BrowserController.dispose()` → SIGTERM + temp user-data-dir cleanup).

Architecture lives in [src/browser/](src/browser/):

- [WsConn.ts](src/browser/WsConn.ts) — zero-dep RFC 6455 client. localhost-only, text frames only, ping/pong + close + fragmentation. ~200 LOC.
- [CdpClient.ts](src/browser/CdpClient.ts) — id→Promise dispatch, event subscribers by `method`, session attached via flatten=true.
- [ChromeFinder.ts](src/browser/ChromeFinder.ts) — Windows-first locator; tries known paths, falls back to `where chrome.exe` / `where msedge.exe`.
- [ConsoleBuffer.ts](src/browser/ConsoleBuffer.ts) — mirror of [RingBuffer.ts](src/RingBuffer.ts) semantics. Same line-number invariant (stable, monotonic, 1-based, never reused, including across `browser_close`).
- [BrowserController.ts](src/browser/BrowserController.ts) — orchestrator. `open` spawns, `navigate` reuses the same target. Console capture via `Runtime.consoleAPICalled` + `Runtime.exceptionThrown`.

Key invariants (must agree with [src/browser/BrowserController.ts](src/browser/BrowserController.ts) header comment — keep both in sync if you change either):

- **No new prod dependencies.** Project's zero-prod-deps invariant is preserved. WS client is hand-rolled.
- **CDP binds 127.0.0.1 only.** `--remote-debugging-address=127.0.0.1` is passed explicitly.
- **Single page target.** No multi-tab management. `browser_navigate` reuses the same `targetId`.
- **`browser_eval` runs in the top frame's main world.** No iframe-deep evaluation.
- **Defaults that match how Claude tends to call eval**: `returnByValue: true`, `awaitPromise: true`, `userGesture: true` (so `.click()` behaves like a real user gesture).
- **No persistent user-data-dir.** Fresh temp dir per spawn under `os.tmpdir()`; removed on dispose.
- **No Chrome found ≠ extension broken.** `browser_open` returns a typed error listing the paths it tried; terminal tools keep working.

Deferred:
- Multi-tab / target management
- Network interception, request log, performance traces
- Iframe-deep evaluation
- Persistent user-data-dir (logins, cookies across sessions)
- Fancy waiters beyond `load` / `domcontentloaded` / a 500 ms quiet-window approximation of `networkidle`
- Driving VSCode's own `editor-browser` debug-type tab (no public API)

If a future change adds any of these, drop the corresponding entry from this list AND from the comment block at the top of [src/browser/BrowserController.ts](src/browser/BrowserController.ts). Both must agree.

## Things to add (deliberately deferred)

- DebugAdapterTrackerFactory for debug console
- onDidStartTaskProcess / onDidEndTaskProcess for task output
- vscode.workspace.tunnels / onDidChangeTunnels for ports
- Output channels (no public list API — opt-in by name)
