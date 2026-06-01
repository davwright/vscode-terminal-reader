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

**Prerequisite:** the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension. This extension is useless without it.

**The easy way** — install from the VSCode Marketplace:

1. Open the Extensions view (`Ctrl+Shift+X`), search for **Terminal Reader for Claude**, click **Install**.
2. Done. The extension auto-registers itself with Claude Code, both extensions notice each other, and the status bar lights up green once a Claude session connects.

**The manual way** — install from a `.vsix`:

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/davwright/vscode-terminal-reader/releases). Nothing to compile.
2. In VSCode: `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → pick the file.
3. Same as above — auto-registration handles the rest.

If the status bar icon stays yellow or red, click it — the tooltip and one-click fixes will tell you what's missing.

## How Claude knows what it can do

You don't have to teach Claude anything. The extension exposes itself as an MCP server, and on first connection Claude calls `tools/list` and reads the tool descriptions and input schemas the extension ships with. From that point on Claude knows the tools below, what each one returns, and how to combine them — for the lifetime of every future Claude session in that VSCode window.

## What Claude can do

All tools live under the `mcp__vscode-reader__*` namespace.

### Terminals and problems

| Tool                  | What it does                                                                |
|-----------------------|------------------------------------------------------------------------------|
| `terminal_list`       | Lists your terminals with their busy state and last command/exit code        |
| `terminal_read`       | Reads output. Supports server-side regex, line ranges, context, three formats |
| `terminal_read_all`   | Same, but across every terminal at once                                      |
| `terminal_state`      | Just the metadata — busy/idle, last command, exit code, line counts          |
| `terminal_run`        | Runs a command in a terminal, gated by your `.claude/settings.local.json` allow/deny rules. Pass `wait:true` to block until it finishes |
| `terminal_wait`       | Blocks until a terminal finishes its current command, a regex matches new output, or timeout. Defaults: 60 s, max 5 min |
| `terminal_interrupt`  | Sends Ctrl-C to abort a runaway command                                       |
| `terminal_clear`      | Clears the captured buffer (your visible terminal isn't touched)              |
| `problems_list`       | Diagnostics from VSCode's Problems panel                                      |
| `problems_summary`    | Counts and top files                                                          |

### Embedded browser

The extension can spawn a Chrome or Edge tab and let Claude inspect it — read the DOM, watch the console, evaluate JavaScript, take screenshots. A sample page lives at [samples/embedded-browser/](samples/embedded-browser/) so you can try it.

| Tool                     | What it does                                                                  |
|--------------------------|--------------------------------------------------------------------------------|
| `browser_open`           | Launches Chrome/Edge and navigates to a URL or workspace-relative file         |
| `browser_navigate`       | Navigates the already-open tab to a new page                                   |
| `browser_eval`           | Evaluates a JS expression in the page (`returnByValue`/`awaitPromise` default on) |
| `browser_console_read`   | Reads captured `console.log`/`warn`/`error` + uncaught exceptions, same grep/range/tail as `terminal_read` |
| `browser_dom_snapshot`   | Compact JSON tree of the live DOM (depth-limited)                              |
| `browser_query_selector` | CSS-selector lookup; returns `{tag, id, classes, text, attrs, html}`           |
| `browser_screenshot`     | PNG/JPEG of the viewport, full page, or a single selector                      |
| `browser_close`          | Tears down the browser tab                                                     |
| `browser_status`         | `{running, browser?, url?, consoleLines}` without driving anything             |

Browser is **CDP over WebSocket** — no Puppeteer, no Playwright, no extra dependencies. It binds to `127.0.0.1` only, the child process dies with the extension host, and the user-data-dir is a fresh temp dir per spawn. Try [samples/embedded-browser/README.md](samples/embedded-browser/README.md) for a five-prompt walkthrough.

## Highlights

**Server-side regex.** Claude doesn't pull the whole buffer and grep it — it asks the extension to filter, with optional context lines, and gets back exactly what it needs.

**Stable line numbers.** Every line gets a 1-based number that never changes, never repeats, never resets. Claude can grep for "error", spot it on line 88, and read lines 80–95 for context in a follow-up call.

**Three output formats.** `text` (compact, default), `json` (programmatic), or `raw` (the unmodified stream including ANSI colours and shell-integration markers — for when Claude needs to see exit codes, command boundaries, or coloured output). Grep, range, tail, and context filters all work on every format — including `raw`, where the bytes inside kept lines are preserved verbatim.

**Polling without re-reading.** `terminal_state` returns just metadata. Claude can wait for a long command to finish without re-fetching megabytes of output every tick.

**Multi-window safe.** Each VSCode window has its own private channel. Multiple windows side by side don't bleed into each other.

**Zero copy-paste.** That's the whole point.

## Running commands (`terminal_run`)

`terminal_run` lets Claude execute commands in your terminal, **gated by an allow/deny list you control**. The point isn't to give Claude broad shell access — it's to let Claude run something verbose (a build, a test suite, a diagnostic dump) and then use `terminal_read`'s grep/range/format tools to find the few lines it actually needs. You spend tokens on the answer, not on streaming megabytes of build output back through tool calls. And because everything goes through the terminal you can see, you watch what Claude does in real time.

By default, `terminal_run` clears the terminal's line-number buffer before sending the command, so a follow-up `terminal_read` returns only this run's output. Your visible terminal scrollback is never touched. Pass `clearFirst: false` to keep prior output addressable.

### Permission rules

Edit `<your-workspace>/.claude/settings.local.json`. The extension reads this file on every `terminal_run` call (no daemon restart needed):

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test*)",
      "Bash(npm run build*)",
      "PowerShell(Get-ChildItem*)"
    ],
    "deny": [
      "Bash(rm *)",
      "Bash(git push*)"
    ]
  }
}
```

- **Same file, same grammar as Claude Code itself.** One source of truth — anything you've authorised for Claude's own Bash tool also works through `terminal_run`. See [Claude Code's permission docs](https://code.claude.com/docs/en/permissions) for the full rule grammar.
- **Default deny.** No matching allow rule → command is rejected.
- **Deny wins.** A deny match overrides any allow.
- **Compound commands are split.** `npm test && rm -rf node_modules` only runs if *both* sub-commands have an allow rule. Splits on `&&`, `||`, `;`, `|`, `&`, newline.
- **Shell-aware.** Rules under `Bash(...)` apply to bash/zsh/fish terminals; `PowerShell(...)` applies to pwsh/PowerShell. The extension picks the namespace per terminal.

### Deferred from the full Claude Code spec

This is a deliberate subset. Currently *not* implemented:

- User-level (`~/.claude/settings.json`) and managed/policy settings layers
- `permissions.ask` rules (treated as deny — there's no MCP UI to prompt through)
- Process-wrapper stripping (so `Bash(npm test *)` won't auto-match `timeout 30 npm test` — write a more permissive rule, or wrap in your own script)
- PowerShell alias canonicalisation (`gci` won't match `Get-ChildItem` rules)
- Read-only command auto-approve (you must explicitly allow `ls`, `cat`, etc.)
- Hot-reload via `fs.watch` (file is re-read on every call instead, which costs a JSON parse and avoids a class of stale-cache bugs)

If any of these become annoying, [open an issue](https://github.com/davwright/vscode-terminal-reader/issues) — see [#3](https://github.com/davwright/vscode-terminal-reader/issues/3) for the full target spec.

## Settings

| Setting                                  | Default | Effect                                        |
|------------------------------------------|---------|-----------------------------------------------|
| `vscodeTerminalReader.bufferLines`       | 10000   | Max lines per terminal kept in memory          |
| `vscodeTerminalReader.stripAnsi`         | true    | Strip ANSI/colour codes from text/json reads  |

## Status bar

The status bar icon shows three states: green (Claude connected), yellow (registered but waiting for Claude to connect), red (not registered). Click it any time for diagnostic detail and one-click recovery actions.

## Limitations

Terminal capture only works when shell integration is on. PowerShell 7.4+, bash, zsh, fish, and git-bash on Windows all auto-enable it. Output produced **before** the extension activated isn't captured — a freshly-reloaded window has empty buffers until commands run.

## Contributing / issues

[github.com/davwright/vscode-terminal-reader](https://github.com/davwright/vscode-terminal-reader) — issues, source, releases.

## License

MIT.
