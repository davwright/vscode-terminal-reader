import { WsConn } from './WsConn';

// CDP request/response router over a single WebSocket.
//
// CDP messages on a "browser-level" connection can target a specific page via
// `sessionId`. For simplicity we only ever attach to one page at a time and
// route all commands through that sessionId (set via setSession()). Events on
// that session are routed by `method` to subscribers.

export type CdpEventListener = (params: any) => void;

interface PendingCall {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class CdpClient {
  private ws: WsConn | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private events = new Map<string, Set<CdpEventListener>>();
  private sessionId: string | null = null;
  private closed = false;

  async connect(wsUrl: string, timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WsConn(wsUrl);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms (${wsUrl})`));
        try {
          ws.close(1001, 'connect timeout');
        } catch {
          // ignore
        }
      }, timeoutMs);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
        this.failAllPending(err);
      });
      ws.on('close', () => {
        this.closed = true;
        this.failAllPending(new Error('CDP connection closed'));
      });
      ws.on('message', (data) => this.onMessage(data));
      ws.connect();
    });
  }

  setSession(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  on(method: string, listener: CdpEventListener): () => void {
    let set = this.events.get(method);
    if (!set) {
      set = new Set();
      this.events.set(method, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  async send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (!this.ws || this.closed) throw new Error('CDP not connected');
    const id = this.nextId++;
    const msg: any = { id, method, params };
    const sid = sessionId ?? this.sessionId;
    if (sid) msg.sessionId = sid;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(msg));
      } catch (e: any) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        // ignore
      }
    }
    this.failAllPending(new Error('CDP client closed'));
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const m = msg.error.message ?? 'CDP error';
        const e = new Error(`${msg.error.code ?? ''} ${m}`.trim());
        (e as any).data = msg.error.data;
        p.reject(e);
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const set = this.events.get(msg.method);
      if (set) {
        for (const fn of set) {
          try {
            fn(msg.params ?? {});
          } catch {
            // listener errors are not the client's problem
          }
        }
      }
    }
  }
}
