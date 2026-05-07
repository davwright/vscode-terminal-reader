import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { TerminalCapture } from './TerminalCapture';
import { ProblemsCapture } from './ProblemsCapture';
import { IpcServer } from './IpcServer';
import { makeDispatcher } from './McpHandlers';
import {
  buildPipeName,
  deleteEndpointFile,
  writeEndpointFile,
  EndpointInfo
} from './Endpoint';

let server: IpcServer | null = null;
let extensionHostPid = process.pid;
let statusBar: vscode.StatusBarItem | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = () => vscode.workspace.getConfiguration('vscodeTerminalReader');
  const maxLines = () => cfg().get<number>('bufferLines', 10000);
  const stripAnsi = () => cfg().get<boolean>('stripAnsi', true);

  const terminals = new TerminalCapture(maxLines);
  const problems = new ProblemsCapture();
  context.subscriptions.push(terminals);

  const dispatch = makeDispatcher({ terminals, problems, stripAnsi });

  const { pipeName, pipePath } = buildPipeName(extensionHostPid);
  const token = crypto.randomBytes(16).toString('hex');

  server = new IpcServer(pipePath, token, dispatch);
  try {
    await server.listen();
  } catch (e: any) {
    vscode.window.showErrorMessage(`Terminal Reader: failed to start IPC server: ${e?.message ?? e}`);
    return;
  }

  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  const info: EndpointInfo = {
    pipeName,
    pipePath,
    workspaceRoot: wsRoot,
    windowPid: getParentPid(),
    extensionHostPid,
    startedAt: Date.now(),
    token,
    protocolVersion: 1
  };
  writeEndpointFile(info);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'vscodeTerminalReader.showStatus';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // State drives status bar text/icon/colour and the click-through advice.
  // - notRegistered: mcp.json missing entry → broken icon, advise registration.
  // - connecting: registered, within grace period for the bridge to auth →
  //   neutral spinner, no background. Avoids drawing attention during the
  //   normal 5-10s connect window.
  // - registeredAwaitingClient: still no bridge after the grace period →
  //   warn icon, advise restarting Claude Code.
  // - ready: at least one authed client connected → terminal icon.
  const CONNECT_GRACE_MS = 15_000;
  let regState: 'notRegistered' | 'connecting' | 'registeredAwaitingClient' | 'ready' =
    isRegisteredWithClaude(context) ? 'connecting' : 'notRegistered';
  let graceTimer: NodeJS.Timeout | null = null;
  const renderStatus = () => {
    if (!statusBar) return;
    // Icon-only status bar to save space. States distinguished by icon
    // and background colour; details live in the tooltip and click-through.
    if (regState === 'ready') {
      statusBar.text = `$(terminal)`;
      statusBar.backgroundColor = undefined;
      statusBar.tooltip =
        `Terminal Reader v${version} — connected\n` +
        `Pipe: ${pipePath}\nWorkspace: ${wsRoot ?? '(none)'}`;
    } else if (regState === 'connecting') {
      statusBar.text = `$(sync~spin)`;
      statusBar.backgroundColor = undefined;
      statusBar.tooltip =
        `Terminal Reader v${version} — waiting for Claude Code to connect…\n` +
        `Pipe: ${pipePath}`;
    } else if (regState === 'registeredAwaitingClient') {
      statusBar.text = `$(warning)`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusBar.tooltip =
        `Terminal Reader v${version} — registered but Claude Code hasn't connected.\n` +
        `Reload the VSCode window (Ctrl+Shift+P → "Developer: Reload Window") so the Claude Code extension picks up the MCP server.\n` +
        `Pipe: ${pipePath}`;
    } else {
      statusBar.text = `$(error)`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      statusBar.tooltip =
        `Terminal Reader v${version} — not registered with Claude Code.\n` +
        `Click to retry registration, or run the "Terminal Reader: Register with Claude" command.\n` +
        `Pipe: ${pipePath}`;
    }
  };
  // Set when registration just wrote a new entry — the reload prompt is
  // deferred until the grace timer gives up, so a fast-connecting bridge
  // never sees the popup at all.
  let pendingReloadPrompt = false;
  const startGraceTimer = () => {
    if (graceTimer) clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (regState === 'connecting') {
        regState = 'registeredAwaitingClient';
        renderStatus();
        if (pendingReloadPrompt) {
          pendingReloadPrompt = false;
          void (async () => {
            const choice = await vscode.window.showInformationMessage(
              "Terminal Reader: registered MCP server with Claude Code.\n" +
              "Reload the VSCode window so the Claude Code extension picks up the new MCP server.",
              'Reload window', 'Later'
            );
            if (choice === 'Reload window') {
              await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          })();
        }
      }
    }, CONNECT_GRACE_MS);
  };
  if (regState === 'connecting') startGraceTimer();
  renderStatus();

  context.subscriptions.push(
    server.onClientAuthed(() => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      pendingReloadPrompt = false;
      regState = 'ready';
      renderStatus();
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    }
  });

  // Run registration off the activation path: file I/O on ~/.claude.json
  // shouldn't stall the extension host. Sticky notification (action item
  // keeps it open) and a \n so the message doesn't get cropped.
  setImmediate(async () => {
    try {
      const changed = ensureRegisteredWithClaude(context);
      if (changed) pendingReloadPrompt = true;
      if (regState !== 'ready' && regState !== 'connecting') {
        regState = 'connecting';
        startGraceTimer();
        renderStatus();
      }
    } catch (e: any) {
      regState = 'notRegistered';
      renderStatus();
      void vscode.window.showWarningMessage(
        `Terminal Reader: failed to register with Claude.\n${e?.message ?? e}`,
        'Dismiss'
      );
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeTerminalReader.showStatus', async () => {
      const detail =
        `v${version}  •  Pipe: ${pipePath}  •  Workspace: ${wsRoot ?? '(none)'}  •  ` +
        `Extension host PID: ${extensionHostPid}  •  Window PID: ${info.windowPid}  •  ` +
        `Terminals: ${terminals.list().length}  •  Authed clients: ${server?.authedClientCount ?? 0}`;
      if (regState === 'ready') {
        await vscode.window.showInformationMessage(
          `Terminal Reader: connected.\n${detail}`,
          'Got it'
        );
      } else if (regState === 'connecting') {
        await vscode.window.showInformationMessage(
          `Terminal Reader: waiting for Claude Code to connect…\n${detail}`,
          'Got it'
        );
      } else if (regState === 'registeredAwaitingClient') {
        const pick = await vscode.window.showWarningMessage(
          "Terminal Reader is registered with Claude Code but no client has connected yet.\n" +
          "Reload the VSCode window so the Claude Code extension picks up the MCP server.\n\n" + detail,
          'Reload window', 'Dismiss'
        );
        if (pick === 'Reload window') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        const pick = await vscode.window.showErrorMessage(
          "Terminal Reader is not registered with Claude.\n" +
          "Click 'Register' to write the MCP entry to ~/.claude/mcp.json, then restart Claude Code.\n\n" + detail,
          'Register', 'Dismiss'
        );
        if (pick === 'Register') {
          await registerWithClaude(context);
          if (isRegisteredWithClaude(context)) {
            regState = 'connecting';
            startGraceTimer();
            renderStatus();
          }
        }
      }
    }),
    vscode.commands.registerCommand('vscodeTerminalReader.clearBuffers', () => {
      terminals.clear();
      vscode.window.showInformationMessage('Terminal Reader: buffers cleared');
    }),
    vscode.commands.registerCommand('vscodeTerminalReader.register', () => registerWithClaude(context)),
    vscode.commands.registerCommand('vscodeTerminalReader.unregister', () => unregisterFromClaude())
  );

  context.subscriptions.push({
    dispose: () => {
      try {
        server?.dispose();
      } catch {
        // ignore
      }
      deleteEndpointFile(extensionHostPid);
    }
  });
}

export function deactivate(): void {
  try {
    server?.dispose();
  } catch {
    // ignore
  }
  deleteEndpointFile(extensionHostPid);
}

function getParentPid(): number {
  const ppid = (process as NodeJS.Process & { ppid?: number }).ppid;
  return typeof ppid === 'number' ? ppid : extensionHostPid;
}

// User-scope MCP config for Claude Code. CLI and VSCode extension both read
// this; CLAUDE_CONFIG_DIR overrides the home directory. See
// ~/.claude/skills/claude-code-mcp/SKILL.md for the full reference.
function claudeConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? os.homedir();
  return path.join(dir, '.claude.json');
}

function bridgePath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'bridge', 'mcp-bridge.js');
}

function readClaudeMcp(): any {
  const file = claudeConfigPath();
  if (!fs.existsSync(file)) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

function writeClaudeMcp(data: any): void {
  // Atomic write: ~/.claude.json may be open by Claude Code. Write to a temp
  // sibling and rename so we never leave a half-written file behind.
  const target = claudeConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + `.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

const SERVER_NAME = 'vscode-reader';

function isRegisteredWithClaude(context: vscode.ExtensionContext): boolean {
  const data = readClaudeMcp();
  const existing = data?.mcpServers?.[SERVER_NAME];
  return (
    !!existing &&
    existing.type === 'stdio' &&
    existing.command === 'node' &&
    Array.isArray(existing.args) &&
    existing.args[0] === bridgePath(context)
  );
}

function ensureRegisteredWithClaude(context: vscode.ExtensionContext): boolean {
  // Migrate away from the old, wrong path: ~/.claude/mcp.json. Earlier
  // versions wrote there, but Claude Code reads ~/.claude.json (top-level
  // mcpServers = user scope). If the legacy file still has our entry, drop it
  // so we don't leave dangling registrations behind.
  cleanupLegacyMcpJson();

  const data = readClaudeMcp();
  data.mcpServers = data.mcpServers ?? {};
  const expected = {
    type: 'stdio',
    command: 'node',
    args: [bridgePath(context)]
  };
  const existing = data.mcpServers[SERVER_NAME];
  if (
    existing &&
    existing.type === expected.type &&
    existing.command === expected.command &&
    Array.isArray(existing.args) &&
    existing.args.length === expected.args.length &&
    existing.args[0] === expected.args[0]
  ) {
    return false;
  }
  data.mcpServers[SERVER_NAME] = expected;
  writeClaudeMcp(data);
  return true;
}

function cleanupLegacyMcpJson(): void {
  const legacy = path.join(os.homedir(), '.claude', 'mcp.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const raw = fs.readFileSync(legacy, 'utf8');
    const data = JSON.parse(raw);
    if (data?.mcpServers && data.mcpServers[SERVER_NAME]) {
      delete data.mcpServers[SERVER_NAME];
      fs.writeFileSync(legacy, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch {
    // Legacy file unreadable — leave it alone.
  }
}

async function registerWithClaude(context: vscode.ExtensionContext): Promise<void> {
  const changed = ensureRegisteredWithClaude(context);
  if (changed) {
    const pick = await vscode.window.showInformationMessage(
      "Registered 'vscode-reader' MCP server with Claude Code.\n" +
      "Reload the VSCode window so the Claude Code extension picks up the new MCP server.",
      'Reload window', 'Later'
    );
    if (pick === 'Reload window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else {
    await vscode.window.showInformationMessage(
      "'vscode-reader' is already registered with Claude Code.",
      'Got it'
    );
  }
}

async function unregisterFromClaude(): Promise<void> {
  cleanupLegacyMcpJson();
  const data = readClaudeMcp();
  if (data?.mcpServers && data.mcpServers[SERVER_NAME]) {
    delete data.mcpServers[SERVER_NAME];
    writeClaudeMcp(data);
    await vscode.window.showInformationMessage(
      `Unregistered '${SERVER_NAME}' MCP server.`,
      'Got it'
    );
  } else {
    await vscode.window.showInformationMessage(
      `'${SERVER_NAME}' was not registered.`,
      'Got it'
    );
  }
}
