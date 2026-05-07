# Terminal Reader for Claude

> Stop copy-pasting terminal output into Claude. Let it read your terminal directly.

[![Source on GitHub](https://img.shields.io/badge/source-github-181717?logo=github)](https://github.com/davwright/vscode-terminal-reader)

![icon](resources/icon.png)

## What it does

When [Claude Code](https://code.claude.com) is running in your VSCode window, this extension lets it see exactly what's in your terminals and Problems panel — live. No more "what was that error?", no more pasting screenshots, no more `Ctrl+A Ctrl+C`.

Ask Claude:

- *"Why did the build fail?"* — it reads the terminal output, finds the error, and looks at the surrounding context.
- *"What's still failing in my test run?"* — it filters for failures and reads only those.
- *"Wait until the deploy finishes and then check for warnings."* — it polls in the background, then reports back.
- *"Cancel that command."* — it sends Ctrl-C.

The extension does the heavy lifting (server-side regex, line-numbered ranges, raw stream access) so Claude spends tokens on solving your problem, not parsing your screen.

## Install

1. Install the `.vsix` (or grab it from the [GitHub Releases](https://github.com/davwright/vscode-terminal-reader/releases)).
2. Reload the VSCode window. The extension auto-registers itself with Claude Code.
3. Reload **once more** so Claude Code picks up the new MCP server.
4. The status bar icon turns from `$(warning)` to `$(terminal)` once a Claude session connects. Done.

If anything's wrong, click the status bar icon — it tells you what's missing and offers a one-click fix.

## What Claude can do

Eight tools, all under the `mcp__vscode-reader__*` namespace:

| Tool                  | What it does                                                                |
|-----------------------|------------------------------------------------------------------------------|
| `terminal_list`       | Lists your terminals with their busy state and last command/exit code        |
| `terminal_read`       | Reads output. Supports server-side regex, line ranges, context, three formats |
| `terminal_read_all`   | Same, but across every terminal at once                                      |
| `terminal_state`      | Just the metadata — busy/idle, last command, exit code, line counts          |
| `terminal_interrupt`  | Sends Ctrl-C to abort a runaway command                                       |
| `terminal_clear`      | Clears the captured buffer (your visible terminal isn't touched)              |
| `problems_list`       | Diagnostics from VSCode's Problems panel                                      |
| `problems_summary`    | Counts and top files                                                          |

## Highlights

**Server-side regex.** Claude doesn't pull the whole buffer and grep it — it asks the extension to filter, with optional context lines, and gets back exactly what it needs.

**Stable line numbers.** Every line gets a 1-based number that never changes, never repeats, never resets. Claude can grep for "error", spot it on line 88, and read lines 80–95 for context in a follow-up call.

**Three output formats.** `text` (compact, default), `json` (programmatic), or `raw` (the unmodified stream including ANSI colours and shell-integration markers — for when Claude needs to see exit codes, command boundaries, or coloured output).

**Polling without re-reading.** `terminal_state` returns just metadata. Claude can wait for a long command to finish without re-fetching megabytes of output every tick.

**Multi-window safe.** Each VSCode window has its own private channel. Multiple windows side by side don't bleed into each other.

**Zero copy-paste.** That's the whole point.

## Settings

| Setting                                  | Default | Effect                                        |
|------------------------------------------|---------|-----------------------------------------------|
| `vscodeTerminalReader.bufferLines`       | 10000   | Max lines per terminal kept in memory          |
| `vscodeTerminalReader.stripAnsi`         | true    | Strip ANSI/colour codes from text/json reads  |

## Status bar

A single icon, three states:

- `$(terminal)` — Claude is connected. Everything's working.
- `$(warning)` — Registered, but Claude hasn't connected yet. Click for a one-click reload.
- `$(error)` — Not registered. Click to fix.

Click the icon any time for diagnostic detail and recovery actions.

## Limitations

Terminal capture only works when shell integration is on. PowerShell 7.4+, bash, zsh, fish, and git-bash on Windows all auto-enable it. Output produced **before** the extension activated isn't captured — a freshly-reloaded window has empty buffers until commands run.

## Contributing / issues

[github.com/davwright/vscode-terminal-reader](https://github.com/davwright/vscode-terminal-reader) — issues, source, releases.

## License

MIT.
