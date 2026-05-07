#!/usr/bin/env node
'use strict';

// MCP stdio bridge for Terminal Reader.
//
// Spawned by Claude. Speaks MCP JSON-RPC on stdin/stdout. Discovers the
// running VSCode window's IPC endpoint, authenticates, and forwards
// tools/list and tools/call to the extension's IPC server.
//
// Discovery order:
//   1. cwd matches an endpoint's workspaceRoot
//   2. ancestor process pid matches windowPid
//   3. most recently started endpoint
//
// All log output goes to stderr; stdout is reserved for MCP JSON-RPC frames.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const log = (...args) => {
  if (process.env.VSCODE_TR_DEBUG) {
    process.stderr.write('[vscode-tr] ' + args.map(String).join(' ') + '\n');
  }
};

const APP_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'vscode-terminal-reader')
  : path.join(os.homedir(), '.vscode-terminal-reader');
const WINDOWS_DIR = path.join(APP_DIR, 'windows');

function listEndpoints() {
  if (!fs.existsSync(WINDOWS_DIR)) return [];
  const files = fs.readdirSync(WINDOWS_DIR).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(WINDOWS_DIR, f), 'utf8');
      const ep = JSON.parse(raw);
      if (isPidAlive(ep.extensionHostPid)) {
        out.push(ep);
      } else {
        try { fs.unlinkSync(path.join(WINDOWS_DIR, f)); } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // ignore corrupt
    }
  }
  return out;
}

function isPidAlive(pid) {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function pickEndpoint() {
  const eps = listEndpoints();
  if (eps.length === 0) {
    throw new Error('no running VSCode Terminal Reader extension found (no endpoint files)');
  }
  const cwd = process.cwd();
  const matches = eps
    .filter((e) => e.workspaceRoot && (cwd === e.workspaceRoot || cwd.startsWith(e.workspaceRoot + path.sep)))
    .sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length);
  if (matches.length === 0) {
    const known = eps.map((e) => e.workspaceRoot || '(no workspace)').join(', ');
    throw new Error(`no VSCode window has cwd '${cwd}' inside its workspace; running workspaces: ${known}`);
  }
  return matches[0];
}

// ---- IPC client ----

function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint.pipePath);
    sock.setEncoding('utf8');
    sock.once('error', reject);
    sock.once('connect', () => resolve(sock));
  });
}

let nextId = 1;
function sendRpc(sock, method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id === id) {
          sock.off('data', onData);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
          return;
        }
      }
    };
    sock.on('data', onData);
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// ---- MCP stdio loop ----

let stdinBuf = '';

function writeMcp(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const SERVER_INFO = { name: 'vscode-reader', version: '0.0.1' };

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function ensureConnected(state) {
  if (state.sock && !state.sock.destroyed) return state.sock;
  const ep = pickEndpoint();
  const sock = await connect(ep);
  await sendRpc(sock, 'auth', { token: ep.token });
  state.sock = sock;
  state.endpoint = ep;
  log('connected to', ep.pipePath, 'workspace=', ep.workspaceRoot);
  return sock;
}

async function handleMcp(state, msg) {
  const { method, id, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return writeMcp({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO
          }
        });
      case 'notifications/initialized':
        return; // notification, no response
      case 'tools/list': {
        const sock = await ensureConnected(state);
        const result = await sendRpc(sock, 'tools/list', {});
        return writeMcp({ jsonrpc: '2.0', id, result });
      }
      case 'tools/call': {
        const sock = await ensureConnected(state);
        const result = await sendRpc(sock, 'tools/call', params);
        return writeMcp({ jsonrpc: '2.0', id, result });
      }
      case 'ping':
        return writeMcp({ jsonrpc: '2.0', id, result: {} });
      default:
        if (id !== undefined && id !== null) {
          return writeMcp(makeError(id, -32601, `method not found: ${method}`));
        }
    }
  } catch (e) {
    if (id !== undefined && id !== null) {
      writeMcp(makeError(id, -32000, e && e.message ? e.message : String(e)));
    } else {
      log('notification error:', e && e.message);
    }
  }
}

function main() {
  const state = { sock: null, endpoint: null };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuf += chunk;
    let nl = stdinBuf.indexOf('\n');
    while (nl !== -1) {
      const line = stdinBuf.slice(0, nl);
      stdinBuf = stdinBuf.slice(nl + 1);
      nl = stdinBuf.indexOf('\n');
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) {
        writeMcp(makeError(null, -32700, 'parse error'));
        continue;
      }
      handleMcp(state, msg);
    }
  });
  process.stdin.on('end', () => {
    if (state.sock) try { state.sock.end(); } catch (_) { /* ignore */ }
    process.exit(0);
  });
}

main();
