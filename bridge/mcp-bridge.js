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

// Bridge ships inside the .vsix; its own version is the on-disk extension
// version. Sent during auth so the host can detect that the user installed a
// newer .vsix but hasn't reloaded the window (the host is still running the
// old code).
function readBridgeVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch (_) {
    return null;
  }
}
const BRIDGE_VERSION = readBridgeVersion();

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

const SERVER_INFO = { name: 'vscode-reader', version: BRIDGE_VERSION || '0.0.0' };

// Server-level guidance surfaced to the model on connect. The job here is to
// flip the default instinct — "loop calling terminal_state with a sleep" —
// into the event-driven pattern this server is built for: launch once, then
// block on a real signal (shell-integration D-mark or a regex you choose).
const SERVER_INSTRUCTIONS = [
  '# vscode-reader — drive long-running terminal commands without polling',
  '',
  'This server is a control loop for the live terminals in the user\'s VSCode window. You can',
  'start a command, then BLOCK efficiently until it finishes or until a line you care about',
  'appears — no sleep loops, no repeated status checks. One tool call sleeps server-side and',
  'wakes the instant the signal fires.',
  '',
  '## Do this — block on a signal, not a timer',
  '',
  'Run-and-wait in a single call:',
  "  terminal_run({ command: 'npm run build', wait: true })",
  '→ returns the moment shell integration reports the command ended, with its exitCode. The',
  '  call sleeps the whole time; it costs you nothing until it wakes.',
  '',
  'Return early on a meaningful line (a dev server that never "ends", or a failure you want to',
  'bail on before the full run completes) — returnOnPattern is a JS regex matched live against',
  'each new (ANSI-stripped) output line:',
  "  terminal_run({ command: 'npm run dev', wait: true, returnOnPattern: 'Listening on port \\\\d+' })",
  "  terminal_run({ command: 'npm test',    wait: true, returnOnPattern: 'failed|Error:|✗' })",
  '→ wakes on the first matching line OR command end OR timeout, whichever is first. Use it for',
  '  readiness probes (server up) and for early bail-out (first error) alike.',
  '',
  'Wait on something you did NOT launch via this server — a command the user typed, or one you',
  'started earlier without wait:true:',
  "  terminal_wait({ returnOnPattern: 'Compiled successfully', timeoutMs: 120000 })",
  '',
  '## The pattern for jobs longer than the 5-minute wait cap',
  '',
  'A single wait is capped at 300000 ms (5 min). For a longer job, do NOT switch to a sleep',
  'loop — re-arm the wait. terminal_wait blocks server-side again from where it left off:',
  "  loop: terminal_wait({ returnOnPattern: 'BUILD SUCCESSFUL|BUILD FAILED', timeoutMs: 300000 })",
  '        — reason:\'pattern\' → done. reason:\'timeout\' → call it again. reason:\'finished\' → it ended.',
  'Each iteration is one blocking call that wakes on the real event; you are not burning turns',
  'spinning. Only fall back to terminal_state polling when shell integration is OFF (no D-mark,',
  'so reason:\'unsupported\' comes back immediately — see below).',
  '',
  '## Reading output efficiently',
  '',
  'terminal_run clears the line buffer and returns runId = the first line number of this run.',
  'After a wait, fetch only this run\'s output: terminal_read({ range: [runId, totalLines] }).',
  'grep server-side instead of pulling the whole buffer: terminal_read({ grep: \'error\', context: 3 }).',
  'Line numbers are stable and monotonic across the buffer\'s life — grep to find line N, then',
  're-read range:[N-3, N+3] for surrounding context.',
  '',
  '## When the blocking calls won\'t work',
  '',
  'Waiting needs shell integration (OSC 633 D-marks) to know when a command ends. If it is off,',
  'terminal_run/terminal_wait return reason:\'unsupported\' immediately — that is the ONLY case',
  'where you should poll terminal_state in a loop (use totalLines to fetch just new lines).',
  'terminal_interrupt sends Ctrl-C to kill a runaway command; it is never gated by permissions.'
].join('\n');

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function ensureConnected(state) {
  if (state.sock && !state.sock.destroyed) return state.sock;
  const ep = pickEndpoint();
  const sock = await connect(ep);
  await sendRpc(sock, 'auth', { token: ep.token, clientVersion: BRIDGE_VERSION });
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
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS
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
