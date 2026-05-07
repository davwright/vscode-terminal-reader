import * as net from 'net';
import * as vscode from 'vscode';

export type RpcHandler = (method: string, params: unknown) => Promise<unknown>;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export class IpcServer implements vscode.Disposable {
  private server: net.Server | null = null;
  private readonly _onClientAuthed = new vscode.EventEmitter<void>();
  readonly onClientAuthed = this._onClientAuthed.event;
  private _authedClientCount = 0;
  get authedClientCount(): number { return this._authedClientCount; }
  get isListening(): boolean { return this.server?.listening === true; }

  constructor(
    private readonly pipePath: string,
    private readonly token: string,
    private readonly handler: RpcHandler
  ) {}

  async listen(): Promise<void> {
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.pipePath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    let authed = false;
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line.trim()) continue;
        await this.processLine(socket, line, () => authed, (v) => {
          if (v && !authed) {
            this._authedClientCount++;
            this._onClientAuthed.fire();
          }
          authed = v;
        });
      }
    });
    socket.on('close', () => {
      if (authed) this._authedClientCount = Math.max(0, this._authedClientCount - 1);
    });
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
  }

  private async processLine(
    socket: net.Socket,
    line: string,
    isAuthed: () => boolean,
    setAuthed: (v: boolean) => void
  ): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      this.send(socket, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }

    if (!isAuthed()) {
      if (req.method === 'auth' && (req.params as any)?.token === this.token) {
        setAuthed(true);
        this.send(socket, { jsonrpc: '2.0', id: req.id ?? null, result: { ok: true } });
      } else {
        this.send(socket, {
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: -32001, message: 'unauthenticated' }
        });
        socket.end();
      }
      return;
    }

    try {
      const result = await this.handler(req.method, req.params);
      this.send(socket, { jsonrpc: '2.0', id: req.id ?? null, result });
    } catch (e: any) {
      this.send(socket, {
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32000, message: e?.message ?? String(e) }
      });
    }
  }

  private send(socket: net.Socket, msg: JsonRpcResponse): void {
    try {
      socket.write(JSON.stringify(msg) + '\n');
    } catch {
      // socket dead
    }
  }

  dispose(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }
    this._onClientAuthed.dispose();
  }
}
