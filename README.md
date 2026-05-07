# Terminal Reader for Claude

A VSCode extension that gives [Claude Code](https://code.claude.com) access to the live state of *this* VSCode window's terminals and Problems panel via a local MCP server. No copy-paste. No "what was the error again?". Claude reads the terminal directly.

![icon](resources/icon.png)

## What it gives Claude

Seven MCP tools, registered as `mcp__vscode-reader__*`:

| Tool                  | Purpose                                                                |
|-----------------------|------------------------------------------------------------------------|
| `terminal_list`       | All terminals, with shell-integration state and `busy` flag            |
| `terminal_read`       | Output from one terminal (text / json / raw formats; grep, range, context) |
| `terminal_read_all`   | Same, across every terminal                                            |
| `terminal_state`      | Just the metadata — busy/idle, last command, exit code, total lines     |
| `terminal_interrupt`  | Send Ctrl-C to abort a runaway command                                  |
| `terminal_clear`      | Clear the captured buffer (visible terminal untouched)                  |
| `problems_list`       | Diagnostics from the Problems panel                                     |
| `problems_summary`    | Counts and top files                                                    |

Multiple VSCode windows can run side by side without bleeding into each other — each window writes its own endpoint file and the bridge picks the right one.

## Setup

1. Install the extension (`.vsix`).
2. Reload the VSCode window. The extension activates and registers itself with Claude Code automatically.
3. Reload one more time so Claude Code's MCP client picks up the new server.
4. The status bar icon turns from yellow `$(warning)` to terminal `$(terminal)` once a Claude session connects.

That's it. All seven tools become available to every Claude session in this window.

If something's wrong, click the status bar icon — it tells you exactly which step is missing and offers a one-click reload.

## How to use it (for Claude — the efficient way)

### 1. Start with `terminal_list`, not `terminal_read`

`terminal_list` is cheap and tells you which terminal you actually want. If `busy: true`, the user is running something. If `lastExitCode` is non-zero, something failed.

```jsonc
[{ "name": "powershell", "cwd": "c:/git/foo", "shellIntegration": true,
   "bufferLines": 142, "busy": false, "lastCommand": "npm test",
   "lastExitCode": 1 }]
```

### 2. For new output, poll `terminal_state`, not `terminal_read`

`terminal_state` returns metadata only — no buffer content. Use it to wait for a long command to finish:

```
seen = 0
state = terminal_state()
while state.status == "busy":
  if state.totalLines > seen:
    new_output = terminal_read({ range: [seen + 1, state.totalLines] })
    seen = state.totalLines
  sleep 2s
  state = terminal_state()
```

`totalLines` increases monotonically across the buffer's whole lifetime, even after eviction. Track the value yourself; the next read fetches only what's new with `range: [seen+1, current.totalLines]`.

### 3. Pick the right `format`

The `format` parameter on `terminal_read` controls response shape and size:

| `format` | Response shape | When to use |
|----------|---------------|-------------|
| `text` (default) | One line per row, `'   142 | <text>'` with padded line numbers | Almost always. Smallest payload, line numbers visible, easy to scan. |
| `json` | `{lines:[{lineNumber, text}, ...]}` | When you need to programmatically iterate or pull individual line numbers. |
| `raw` | Untouched stream including ANSI escapes and OSC 633 markers | When you need to detect **command boundaries**, **exit codes**, or **colours** that the line-based view erases. See the OSC 633 section below. |

`text` is roughly 30% smaller than `json` for typical reads.

### 4. `grep` is server-side regex — let it do the work

Don't read the whole buffer and filter yourself. Pass `grep` and the extension does it:

```jsonc
// Find all lines containing "error" or "fail" (case-insensitive default)
terminal_read({ grep: "error|fail" })

// Same but with 3 lines of context around each match
terminal_read({ grep: "error|fail", context: 3 })

// Strict regex with custom flags
terminal_read({ grep: "TypeError\\b", grepFlags: "" })
```

`grep` is a JS regex source string. `grepFlags` overrides the default `'i'` (case-insensitive). All the standard JS regex features work: alternation, lookahead, character classes.

### 5. `range` for context after grep

Line numbers from any read are stable across reads. Grep first, then range-read for surrounding context:

```jsonc
// Round 1: find errors
terminal_read({ grep: "error" })
// → returns line 88: "error: ENOENT package.json"

// Round 2: get the 10 lines leading up to it
terminal_read({ range: [78, 88] })
```

`range: [start, end]` is inclusive, 1-based. If a line number is past the buffer's start (older lines have been evicted), nothing for that range comes back — never wrong content.

### 6. `terminal_clear` between phases

Long-running session generating noise? Clear before the next operation:

```
terminal_clear()             // current terminal only
terminal_clear({ all: true }) // every terminal
```

Line numbers continue from where they were — they're never reset. This means a follow-up `range` query for old line numbers cleanly returns nothing instead of returning *new* content under the same numbers.

### 7. `terminal_interrupt` to abort

Stuck process? Long compile that's clearly going to fail? Send Ctrl-C:

```
terminal_interrupt()
```

This is not gated by any allowlist — interrupting is always safe.

## Cookbook

### "Find all errors and show me the stack"

```jsonc
terminal_read({ grep: "error|exception|traceback", context: 5 })
```

### "Find all yellow / warning text"

ANSI `33` is yellow (foreground), `93` is bright yellow. Read raw to keep the colour codes, then grep:

```jsonc
terminal_read({
  format: "raw",
  grep: "\\x1b\\[(?:[0-9;]*;)?(?:33|93)(?:;[0-9;]*)?m"
})
```

Or, if your terminal uses `WARNING` / `WARN` semantically (more reliable than colour):

```jsonc
terminal_read({ grep: "\\b(warn|warning)\\b" })
```

### "Find the most recent failed command"

```jsonc
state = terminal_state()
if state.lastExitCode != 0:
  // Read just that command's output. Find the boundary by grepping
  // for the run marker (▶) and reading from there forward.
  marker = terminal_read({ grep: "^▶ " + state.lastCommand, format: "json" })
  start = marker.lines[marker.lines.length - 1].lineNumber
  output = terminal_read({ range: [start, state.totalLines] })
```

### "Detect command boundaries reliably with OSC 633"

VSCode's shell integration emits Operating System Command sequences that mark every prompt, command, and execution boundary. They're the most reliable way to parse a terminal stream, because they're injected by the shell integration script and don't depend on the user's prompt format.

| OSC 633 sequence       | Means                                              |
|------------------------|----------------------------------------------------|
| `ESC ] 633 ; A BEL`    | Prompt start                                        |
| `ESC ] 633 ; B BEL`    | Prompt end                                          |
| `ESC ] 633 ; C BEL`    | Pre-execution (command about to run)                |
| `ESC ] 633 ; D BEL`    | Execution finished (no exit code)                   |
| `ESC ] 633 ; D ; <n> BEL` | Execution finished with exit code `<n>`          |
| `ESC ] 633 ; E ; <cmdline> [; <nonce>] BEL` | Explicit command line       |
| `ESC ] 633 ; P ; <key> = <value> BEL` | Property: `Cwd`, `IsWindows`, `ContinuationPrompt`, `HasRichCommandDetection` |

When `HasRichCommandDetection=True`, sequences arrive in order **A, B, E, C, D**.

To parse them yourself:

```jsonc
terminal_read({ format: "raw", tail: 200 })
// Returns the raw stream including OSC sequences. Match against:
//   /\x1b\]633;C\x07/  → command started
//   /\x1b\]633;D(?:;(\d+))?\x07/  → command ended (with optional exit code)
//   /\x1b\]633;E;([^\x07]*)\x07/  → command line
//   /\x1b\]633;P;Cwd=([^\x07]*)\x07/  → working directory
```

The extension already exposes `lastCommand`, `lastExitCode`, and `busy` via `terminal_state` — those are derived from the same OSC 633 stream. **Use `terminal_state` first.** Only reach for `format: "raw"` and parse OSC yourself when you need something the state API doesn't expose (multiple historical commands, command-line nonces, etc.).

Reference: [VSCode Terminal Shell Integration docs](https://code.visualstudio.com/docs/terminal/shell-integration).

### "Find all build output since the start of `npm test`"

```jsonc
// Find when the command started
state = terminal_state()
// → lastCommand: "npm test", lastCommandStartedAt: 1715000000000

// Find the line where it started
marker = terminal_read({ grep: "^▶ npm test$", tail: 1 })
start = marker.lines[0].lineNumber

// Read everything from there
terminal_read({ range: [start, state.totalLines] })
```

### "Watch for a specific event"

The extension doesn't push events, but polling is cheap. Combine `terminal_state` (fast metadata) with `terminal_read` (only when state changes):

```
prev = terminal_state()
loop forever:
  curr = terminal_state()
  if curr.totalLines > prev.totalLines:
    new = terminal_read({ range: [prev.totalLines + 1, curr.totalLines], grep: "READY" })
    if new.lines.length > 0:
      break
  prev = curr
  sleep 1s
```

## Capture details

VSCode 1.93+ exposes `Terminal.shellIntegration` plus `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`. The extension subscribes to these and reads the per-execution stream into a bounded ring buffer (default 10 000 lines per terminal, 1 MiB raw stream). Old content drops off the front; line numbers are never reused.

**Limitation**: a terminal must have shell integration active for capture to work. PowerShell 7.4+, bash, zsh, fish, git-bash on Windows all auto-enable it. Output produced before shell integration starts is not captured. `terminal_state` reports `status: "unknown"` for terminals where integration is off.

## Multi-window behaviour

Each VSCode extension host writes `%APPDATA%\vscode-terminal-reader\windows\<pid>.json` containing its pipe path, workspace root, window pid, and an auth token. When Claude spawns the bridge, the bridge picks the endpoint that matches:

1. its current working directory (workspace root match), then
2. its parent process tree (ancestor pid == window pid), then
3. the most recently started endpoint.

Stale endpoint files (pid no longer alive) are cleaned up on discovery.

## Settings

| Setting                                  | Default | Effect                                        |
|------------------------------------------|---------|-----------------------------------------------|
| `vscodeTerminalReader.bufferLines`       | 10000   | Max lines per terminal ring buffer            |
| `vscodeTerminalReader.stripAnsi`         | true    | Strip ANSI/OSC sequences from `text` and `json` reads (raw is never stripped) |

## Status bar

A single icon, three states:

- `$(terminal)` — connected. A Claude session has authed and is using the tools.
- `$(warning)` — registered with Claude Code but no client has connected yet. Click for "Reload window".
- `$(error)` — not registered. Click to retry registration.

Click the icon for diagnostic details and recovery actions.

## Layout

```
src/
  extension.ts        activate(), wires captures + IPC + commands
  TerminalCapture.ts  shell-integration listeners, ring buffers, state
  ProblemsCapture.ts  vscode.languages.getDiagnostics()
  IpcServer.ts        named-pipe / unix-socket JSON-RPC server
  Endpoint.ts         per-window endpoint files
  McpHandlers.ts      tool definitions + dispatcher
  RingBuffer.ts       bounded line buffer with stable line numbers
bridge/
  mcp-bridge.js       Claude spawns this; proxies stdio JSON-RPC ↔ pipe
resources/
  icon.svg            Editable icon source
  icon.png            Generated by scripts/build-icon.js (npm run icon)
scripts/
  build-icon.js       SVG → PNG via @resvg/resvg-js
  install-vsix.js     Build + install the .vsix into VSCode
```

## Roadmap

- `terminal_run` — execute commands gated by Claude Code's existing `permissions.allow` rules ([#3](https://github.com/davwright/vscode-terminal-reader/issues/3))
- Debug Console capture (`DebugAdapterTrackerFactory`)
- Tasks: `onDidStartTaskProcess` / `onDidEndTaskProcess`
- Output channels (opt-in by name)
- Forwarded ports (`vscode.workspace.tunnels`)
- SCM status, editor state

## License

MIT. See [LICENSE](LICENSE).
