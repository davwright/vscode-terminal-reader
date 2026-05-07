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
  statusBar.text = '$(terminal) TR';
  statusBar.tooltip = `Terminal Reader\nPipe: ${pipePath}\nWorkspace: ${wsRoot ?? '(none)'}`;
  statusBar.command = 'vscodeTerminalReader.showStatus';
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeTerminalReader.showStatus', () => {
      const lines = [
        `Pipe: ${pipePath}`,
        `Workspace: ${wsRoot ?? '(none)'}`,
        `Extension host PID: ${extensionHostPid}`,
        `Window PID: ${info.windowPid}`,
        `Terminals: ${terminals.list().length}`
      ];
      vscode.window.showInformationMessage(lines.join('  •  '));
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

function claudeMcpPath(): string {
  return path.join(os.homedir(), '.claude', 'mcp.json');
}

function bridgePath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'bridge', 'mcp-bridge.js');
}

function readClaudeMcp(): any {
  const file = claudeMcpPath();
  if (!fs.existsSync(file)) return { mcpServers: {} };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { mcpServers: {} };
  }
}

function writeClaudeMcp(data: any): void {
  fs.mkdirSync(path.dirname(claudeMcpPath()), { recursive: true });
  fs.writeFileSync(claudeMcpPath(), JSON.stringify(data, null, 2), 'utf8');
}

async function registerWithClaude(context: vscode.ExtensionContext): Promise<void> {
  const data = readClaudeMcp();
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers['vscode-reader'] = {
    type: 'stdio',
    command: 'node',
    args: [bridgePath(context)]
  };
  writeClaudeMcp(data);
  vscode.window.showInformationMessage(
    "Registered 'vscode-reader' MCP server with Claude. Restart Claude to pick it up."
  );
}

async function unregisterFromClaude(): Promise<void> {
  const data = readClaudeMcp();
  if (data?.mcpServers && data.mcpServers['vscode-reader']) {
    delete data.mcpServers['vscode-reader'];
    writeClaudeMcp(data);
    vscode.window.showInformationMessage("Unregistered 'vscode-reader' MCP server.");
  } else {
    vscode.window.showInformationMessage("'vscode-reader' was not registered.");
  }
}
