import * as http from 'http';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { Socket } from 'net';

// Minimal RFC 6455 WebSocket client. Scope is intentionally narrow: it speaks
// to chrome --remote-debugging-port on 127.0.0.1, so we never need TLS, never
// need server-mode framing, and never need to deal with deflate extensions.
// Inbound frames are unmasked (server-to-client per spec), outbound frames are
// masked. We handle text frames + ping/pong + close. Fragmentation is
// supported by buffering continuation frames into one onMessage delivery.
//
// API surface chosen to mirror the bits of `ws` we'd use: emit('open'),
// emit('message', string), emit('close'), emit('error', err), send(text).

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WsConn {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: string) => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export class WsConn extends EventEmitter {
  private socket: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: number = 0;
  private closed = false;

  constructor(private readonly url: string) {
    super();
  }

  connect(): void {
    const u = new URL(this.url);
    if (u.protocol !== 'ws:') {
      // We only ever talk to localhost CDP, which is plain ws://.
      queueMicrotask(() => this.emit('error', new Error(`unsupported ws scheme: ${u.protocol}`)));
      return;
    }
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname,
      port: u.port ? Number(u.port) : 80,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      const accept = res.headers['sec-websocket-accept'];
      if (accept !== expected) {
        socket.destroy();
        this.emit('error', new Error('websocket handshake: Sec-WebSocket-Accept mismatch'));
        return;
      }
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('close', () => {
        if (!this.closed) {
          this.closed = true;
          this.emit('close', 1006, 'connection lost');
        }
      });
      socket.on('error', (err) => this.emit('error', err));
      if (head && head.length > 0) this.onData(head);
      this.emit('open');
    });
    req.on('error', (err) => this.emit('error', err));
    req.on('response', (res) => {
      // The server should have responded with 101 Switching Protocols. Anything
      // else means the handshake failed and 'upgrade' will not fire.
      this.emit('error', new Error(`websocket handshake failed: HTTP ${res.statusCode}`));
    });
    req.end();
  }

  send(text: string): void {
    if (!this.socket || this.closed) return;
    const payload = Buffer.from(text, 'utf8');
    const frame = this.buildFrame(OP_TEXT, payload, true);
    this.socket.write(frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    if (this.socket) {
      try {
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
        payload.writeUInt16BE(code, 0);
        if (reason) payload.write(reason, 2, 'utf8');
        this.socket.write(this.buildFrame(OP_CLOSE, payload, true));
        this.socket.end();
      } catch {
        // socket already gone — ignore
      }
    }
  }

  private buildFrame(opcode: number, payload: Buffer, fin: boolean): Buffer {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      // Node Buffers don't have writeUInt64BE — write hi/lo halves.
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    return Buffer.concat([header, mask, masked]);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    // Parse as many whole frames as we have.
    while (true) {
      const frame = this.tryParseFrame();
      if (!frame) return;
      this.handleFrame(frame.fin, frame.opcode, frame.payload);
    }
  }

  private tryParseFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    if (this.buf.length < 2) return null;
    const b0 = this.buf[0];
    const b1 = this.buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let cursor = 2;
    if (len === 126) {
      if (this.buf.length < cursor + 2) return null;
      len = this.buf.readUInt16BE(cursor);
      cursor += 2;
    } else if (len === 127) {
      if (this.buf.length < cursor + 8) return null;
      const hi = this.buf.readUInt32BE(cursor);
      const lo = this.buf.readUInt32BE(cursor + 4);
      if (hi !== 0) {
        // > 4 GiB. CDP doesn't ever do this; fail loud.
        this.emit('error', new Error('frame too large'));
        return null;
      }
      len = lo;
      cursor += 8;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (this.buf.length < cursor + 4) return null;
      maskKey = this.buf.slice(cursor, cursor + 4);
      cursor += 4;
    }
    if (this.buf.length < cursor + len) return null;
    let payload = this.buf.slice(cursor, cursor + len);
    if (maskKey) {
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
      payload = unmasked;
    }
    this.buf = this.buf.slice(cursor + len);
    return { fin, opcode, payload };
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === OP_PING) {
      // Reply with a pong carrying the same payload.
      if (this.socket && !this.closed) this.socket.write(this.buildFrame(OP_PONG, payload, true));
      return;
    }
    if (opcode === OP_PONG) {
      return;
    }
    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
      if (!this.closed) {
        this.closed = true;
        if (this.socket) {
          try {
            this.socket.write(this.buildFrame(OP_CLOSE, payload, true));
            this.socket.end();
          } catch {
            // ignore
          }
        }
        this.emit('close', code, reason);
      }
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (fin) {
        this.deliver(opcode, payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }
      return;
    }
    if (opcode === OP_CONT) {
      this.fragments.push(payload);
      if (fin) {
        const all = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.deliver(op, all);
      }
      return;
    }
    // Unknown opcode. Per spec we should fail the connection; in practice
    // chrome doesn't send these, so we log and move on.
    this.emit('error', new Error(`unknown ws opcode: ${opcode}`));
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (opcode === OP_TEXT) {
      this.emit('message', payload.toString('utf8'));
    }
    // Binary frames are dropped — CDP is all-JSON over text frames.
  }
}
