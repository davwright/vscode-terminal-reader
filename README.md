# Terminal Reader for Claude

A VSCode extension that lets Claude Code read the **current** VSCode window's terminals, problems, debug, tasks, and ports through a local MCP server.

Each VSCode window starts its own pipe and writes a small endpoint file. A bridge script (spawned by Claude) discovers the right window — by working directory, by process ancestry, or by recency — so multiple VSCodes running side by side don't bleed into each other.

## What it exposes today (PoC)

MCP tools published as `mcp__vscode-reader__*`:

- `terminal_list` — terminals in this window with shell-integration state, last command, last exit code
- `terminal_read` — last N lines from one terminal, optionally regex-filtered
- `terminal_read_all` — same, across all terminals
- `problems_list` — Problems-panel diagnostics (filterable by severity/path)
- `problems_summary` — counts and top files

Planned next: debug console, output channels, tasks, forwarded ports, SCM, editor state, `terminal_run`.

## How terminal capture works

VSCode 1.93+ exposes `Terminal.shellIntegration` plus `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`. The extension subscribes to these and reads the per-execution stream into a bounded ring buffer (default 10 000 lines per terminal). Old content drops off the front.

**Limitation**: a terminal must have shell integration active for capture to work. PowerShell 7.4+, bash, zsh, fish, git-bash on Windows all auto-enable it. Output produced before shell integration starts is not captured.

## Setup

```powershell
npm install
npm run compile
```

Press `F5` to launch an Extension Development Host, then in that window run the command **Terminal Reader: Register MCP server with Claude**. That appends an entry to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "vscode-reader": {
      "type": "stdio",
      "command": "node",
      "args": ["<extension>/bridge/mcp-bridge.js"]
    }
  }
}
```

Restart Claude. The tools appear as `mcp__vscode-reader__*`.

## Multi-window behaviour

Each VSCode extension host writes `%APPDATA%\vscode-terminal-reader\windows\<pid>.json` containing its pipe path, workspace root, window pid, and an auth token. When Claude spawns the bridge, the bridge picks the endpoint that matches:

1. its current working directory (workspace root match), then
2. its parent process tree (ancestor pid == window pid), then
3. the most recently started endpoint.

Stale endpoint files (pid no longer alive) are cleaned up on discovery.

## Settings

- `vscodeTerminalReader.bufferLines` — max lines per terminal buffer (default 10 000)
- `vscodeTerminalReader.stripAnsi` — strip ANSI escape codes on read (default true)

## Layout

```
src/
  extension.ts        activate(), wires captures + IPC + commands
  TerminalCapture.ts  shell-integration listeners + ring buffers
  ProblemsCapture.ts  vscode.languages.getDiagnostics()
  IpcServer.ts        named-pipe / unix-socket JSON-RPC server
  Endpoint.ts         per-window endpoint files
  McpHandlers.ts      tool definitions + dispatcher
  RingBuffer.ts       bounded line buffer + ANSI strip
bridge/
  mcp-bridge.js       Claude spawns this; proxies stdio JSON-RPC ↔ pipe
```

## Roadmap

- M2: `DebugAdapterTrackerFactory` for debug console capture; `TaskProcess` events; `tunnels`; output-channel opt-in
- M3: SCM status, editor state, optional `terminal_run`, packaged VSIX
