import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

export interface EndpointInfo {
  pipeName: string;
  pipePath: string;
  workspaceRoot: string | null;
  windowPid: number;
  extensionHostPid: number;
  startedAt: number;
  token: string;
  protocolVersion: 1;
}

const APP_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'vscode-terminal-reader')
  : path.join(os.homedir(), '.vscode-terminal-reader');

const WINDOWS_DIR = path.join(APP_DIR, 'windows');

export function endpointsDir(): string {
  return WINDOWS_DIR;
}

export function ensureEndpointsDir(): void {
  fs.mkdirSync(WINDOWS_DIR, { recursive: true });
}

export function buildPipeName(pid: number): { pipeName: string; pipePath: string } {
  const id = `vscode-tr-${pid}-${crypto.randomBytes(3).toString('hex')}`;
  const pipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\${id}`
      : path.join(os.tmpdir(), `${id}.sock`);
  return { pipeName: id, pipePath };
}

export function writeEndpointFile(info: EndpointInfo): string {
  ensureEndpointsDir();
  const file = path.join(WINDOWS_DIR, `${info.extensionHostPid}.json`);
  fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf8');
  return file;
}

export function deleteEndpointFile(extensionHostPid: number): void {
  const file = path.join(WINDOWS_DIR, `${extensionHostPid}.json`);
  try {
    fs.unlinkSync(file);
  } catch {
    // ignore
  }
}

export function listEndpointFiles(): EndpointInfo[] {
  ensureEndpointsDir();
  const files = fs.readdirSync(WINDOWS_DIR).filter((f) => f.endsWith('.json'));
  const out: EndpointInfo[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(WINDOWS_DIR, f), 'utf8');
      out.push(JSON.parse(raw));
    } catch {
      // skip corrupt
    }
  }
  return out;
}
