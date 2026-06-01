// Runs the user's Claude Code PreToolUse hooks against terminal_run commands.
// Reads ~/.claude/settings.json (CLAUDE_CONFIG_DIR-aware), finds entries whose
// matcher matches the synthetic tool name (Bash or PowerShell), spawns each
// matching command-form hook with the same JSON-on-stdin contract Claude Code
// itself uses, and translates the hook's exit code / stdout into an allow/block.
//
// Why this exists: terminal_run lives behind the MCP tool name
// `mcp__vscode-reader__terminal_run`. The user's PreToolUse/Bash hooks (e.g.
// block-git-write.sh) match on "Bash", so they don't fire for terminal_run.
// That makes terminal_run a side door past the user's own safety nets. This
// module closes it by replaying those hooks before the existing
// Permissions.evaluate() check.
//
// Intentionally NOT implemented in this iteration:
//   - http / mcp_tool / prompt / agent hook types (one-line warning, treat as allow)
//   - exec form (`args` present on a command hook; we only do shell form)
//   - fs.watch hot reload (re-read on every call — same rationale as Permissions.ts)
//
// Contract reference: ~/.claude/skills/claude-code-hooks/events.md.

import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type HookShell = 'bash' | 'powershell';

export type HookDecision =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string; hookCommand: string };

export interface HookEntry {
  type: string;
  command?: string;
  args?: unknown;
  timeout?: number;
}

export interface PreToolGroup {
  matcher: string;
  hooks: HookEntry[];
}

export interface ActiveHookSummary {
  matcher: string;
  command: string;
  type: string;
  timeoutSeconds: number;
  resolvedPath: string | null;
}

const DEFAULT_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 30;
const STDERR_TRIM = 500;

function claudeSettingsPath(): string {
  // Mirror claudeConfigPath() in extension.ts: CLAUDE_CONFIG_DIR wins, else home.
  const dir = process.env.CLAUDE_CONFIG_DIR ?? os.homedir();
  return path.join(dir, '.claude', 'settings.json');
}

function expandTilde(p: string): string {
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Resolve the bash executable to spawn. On Windows, spawning bare `bash` is a
 * trap: Windows resolves it to C:\Windows\System32\bash.exe — the WSL launcher
 * — not Git Bash. With no usable WSL distro that launcher hangs, so every hook
 * ran to timeout (the entire "hooks time out" symptom traced to this). Resolve
 * Git Bash explicitly from its known install locations, falling back to
 * `where bash` only as a last resort (which still risks the System32 shim, so
 * it's last). Cached for the host's lifetime. Non-Windows: plain `bash`.
 */
let cachedBashExe: string | undefined;
function findBashExe(): string {
  if (cachedBashExe !== undefined) return cachedBashExe;
  if (process.platform !== 'win32') {
    cachedBashExe = 'bash';
    return cachedBashExe;
  }
  const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
  const pfx86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const localApp = process.env['LOCALAPPDATA'] ?? path.join(process.env['USERPROFILE'] ?? '', 'AppData', 'Local');
  const candidates = [
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pfx86, 'Git', 'bin', 'bash.exe'),
    path.join(localApp, 'Programs', 'Git', 'bin', 'bash.exe')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedBashExe = c;
      return cachedBashExe;
    }
  }
  // Last resort: `where bash` — skip the System32 WSL shim if it's the hit.
  try {
    const r = spawnSync('where', ['bash'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const hit = r.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0 && !/\\system32\\bash\.exe$/i.test(s));
      if (hit) {
        cachedBashExe = hit;
        return cachedBashExe;
      }
    }
  } catch {
    // ignore
  }
  cachedBashExe = 'bash';
  return cachedBashExe;
}

/**
 * Match a tool name against a Claude Code matcher string. Empty string and
 * "*" both match everything. Otherwise treat as a regex anchored with ^...$,
 * case-sensitive (Claude Code's matcher is case-sensitive for tool events).
 * Falls back to literal equality if the regex won't compile.
 */
function matcherMatches(matcher: string, toolName: string): boolean {
  if (matcher === '' || matcher === '*') return true;
  try {
    const re = new RegExp(`^${matcher}$`);
    return re.test(toolName);
  } catch {
    return matcher === toolName;
  }
}

/**
 * Pull the bash-style executable token off the front of a shell command
 * string. Honours one level of single or double quotes so e.g.
 * `"/c/Program Files/Git/bin/bash.exe" foo` parses correctly.
 */
function splitFirstToken(command: string): { head: string; rest: string } {
  const trimmed = command.trimStart();
  if (trimmed.startsWith('"')) {
    const close = trimmed.indexOf('"', 1);
    if (close > 0) {
      return { head: trimmed.slice(1, close), rest: trimmed.slice(close + 1).trimStart() };
    }
  }
  if (trimmed.startsWith("'")) {
    const close = trimmed.indexOf("'", 1);
    if (close > 0) {
      return { head: trimmed.slice(1, close), rest: trimmed.slice(close + 1).trimStart() };
    }
  }
  const space = trimmed.search(/\s/);
  if (space === -1) return { head: trimmed, rest: '' };
  return { head: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trimStart() };
}

function readSettings(file: string, log: (m: string) => void): any | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    log(`HookRunner: failed to parse ${file}: ${e?.message ?? e}`);
    return null;
  }
}

function preToolGroups(settings: any): PreToolGroup[] {
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return [];
  const out: PreToolGroup[] = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const matcher = typeof g.matcher === 'string' ? g.matcher : '';
    const hooks = Array.isArray(g.hooks) ? g.hooks : [];
    out.push({ matcher, hooks });
  }
  return out;
}

function clampTimeoutSeconds(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_S;
  return Math.min(MAX_TIMEOUT_S, n);
}

/**
 * Spawn one shell-form command hook. Returns its exit code, stdout, stderr.
 * Returns null if the hook timed out (caller treats as non-blocking warning).
 */
async function runHook(
  rawCommand: string,
  payload: string,
  timeoutMs: number,
  log: (m: string) => void
): Promise<{ code: number; stdout: string; stderr: string } | null> {
  const expanded = (() => {
    const { head, rest } = splitFirstToken(rawCommand);
    const expandedHead = expandTilde(head);
    return rest ? `${quoteIfNeeded(expandedHead)} ${rest}` : quoteIfNeeded(expandedHead);
  })();

  // Write payload to a temp file and redirect stdin from it. On Windows, the
  // alternative — piping payload through Node's spawn-stdin into cmd.exe →
  // bash → jq → various subshells — wedges in two different ways:
  //   1. jq prints "writing output failed: Invalid argument" against the
  //      Node-created pipe.
  //   2. cmd.exe holds stdout/stderr open past bash's exit, so the 'close'
  //      event never fires and we run to timeout.
  // Redirecting from a temp file via cmd's `<` makes the hook's stdin a real
  // OS file handle, side-stepping both. Temp file is unlinked after the wait.
  const tmpFile = path.join(os.tmpdir(), `vscode-tr-hook-${process.pid}-${crypto.randomBytes(6).toString('hex')}.json`);
  try {
    fs.writeFileSync(tmpFile, payload, 'utf8');
  } catch (e: any) {
    log(`HookRunner: failed to write payload temp file: ${e?.message ?? e}`);
    return { code: 0, stdout: '', stderr: '' }; // treat as allow
  }
  const cleanup = () => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  };

  // bash works on both platforms (Git Bash on Windows is on PATH for this
  // project's users). Going through bash directly — instead of cmd.exe → bash
  // — avoids cmd's pipe-keep-alive bug and lets bash do its own tilde +
  // backslash handling. Posix-style path for the temp file works because bash
  // accepts both forms on Windows.
  const { head: exec } = splitFirstToken(expanded);
  const posixTmp = tmpFile.replace(/\\/g, '/');
  const posixExec = exec.replace(/\\/g, '/');
  const isShellScript = exec.toLowerCase().endsWith('.sh');
  // For a .sh path bash runs the file. For anything else we let bash invoke it
  // through its own command resolution (handles .exe / .cmd / .bat on Windows
  // via the shim layer Git Bash sets up). The inner `bash` token is resolved
  // too: a bare `bash` inside `bash -c` would re-trip the System32/WSL hijack.
  const bashExe = findBashExe();
  const posixBash = bashExe.replace(/\\/g, '/');
  const inner = isShellScript
    ? `"${posixBash}" "${posixExec}" < "${posixTmp}"`
    : `${expanded} < "${posixTmp}"`;
  const cmd = bashExe;
  const args = ['-c', inner];

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      cleanup();
      log(`HookRunner: hook timed out after ${timeoutMs}ms: ${rawCommand}`);
      resolve(null);
    }, timeoutMs);
    child.on('error', (e: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      log(`HookRunner: spawn error for ${rawCommand}: ${e?.message ?? e}`);
      resolve({ code: 0, stdout: '', stderr: '' }); // treat as allow
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function quoteIfNeeded(p: string): string {
  if (/\s/.test(p) && !p.startsWith('"') && !p.startsWith("'")) return `"${p}"`;
  return p;
}

/**
 * Parse a hook's stdout for a Claude Code-style decision object. Only valid
 * on exit code 0. Returns null when stdout isn't JSON or doesn't carry a
 * decision.
 */
function parseDecision(stdout: string): { reason: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && obj.decision === 'block' && typeof obj.reason === 'string') {
      return { reason: obj.reason };
    }
    if (obj && obj.continue === false && typeof obj.stopReason === 'string') {
      return { reason: obj.stopReason };
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

function shortenStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= STDERR_TRIM) return trimmed;
  return trimmed.slice(0, STDERR_TRIM) + '… (truncated)';
}

export class HookRunner {
  constructor(private readonly log: (msg: string) => void = (m) => process.stderr.write(`[vscode-tr] ${m}\n`)) {}

  /**
   * List the hooks that WOULD run for a given shell, in matcher-resolved
   * order. Used by the status bar to advertise what's armed. Returns empty
   * array if settings.json is missing or has no PreToolUse hooks.
   */
  listActiveHooks(shell: HookShell): ActiveHookSummary[] {
    const settings = readSettings(claudeSettingsPath(), this.log);
    if (!settings) return [];
    const toolName = shell === 'powershell' ? 'PowerShell' : 'Bash';
    const out: ActiveHookSummary[] = [];
    for (const group of preToolGroups(settings)) {
      if (!matcherMatches(group.matcher, toolName)) continue;
      for (const h of group.hooks) {
        if (h.type !== 'command' || typeof h.command !== 'string') continue;
        const { head } = splitFirstToken(h.command);
        const resolvedPath = (() => {
          const expanded = expandTilde(head);
          try {
            return fs.existsSync(expanded) ? expanded : null;
          } catch {
            return null;
          }
        })();
        out.push({
          matcher: group.matcher,
          command: h.command,
          type: h.type,
          timeoutSeconds: clampTimeoutSeconds(h.timeout),
          resolvedPath
        });
      }
    }
    return out;
  }

  async evaluate(args: {
    command: string;
    shell: HookShell;
    sessionId: string;
    cwd: string;
  }): Promise<HookDecision> {
    const settings = readSettings(claudeSettingsPath(), this.log);
    if (!settings) return { decision: 'allow' };
    const toolName = args.shell === 'powershell' ? 'PowerShell' : 'Bash';
    const payload =
      JSON.stringify({
        session_id: args.sessionId,
        transcript_path: '',
        cwd: args.cwd,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: { command: args.command, description: '' }
      }) + '\n';

    for (const group of preToolGroups(settings)) {
      if (!matcherMatches(group.matcher, toolName)) continue;
      for (const h of group.hooks) {
        if (h.type !== 'command') {
          this.log(`HookRunner: skipping unsupported hook type "${h.type}"`);
          continue;
        }
        if (h.args !== undefined) {
          this.log(`HookRunner: skipping exec-form hook (args present): ${h.command}`);
          continue;
        }
        if (typeof h.command !== 'string' || h.command.trim().length === 0) {
          continue;
        }
        const timeoutMs = clampTimeoutSeconds(h.timeout) * 1000;
        const result = await runHook(h.command, payload, timeoutMs, this.log);
        if (!result) {
          // timeout — non-blocking
          continue;
        }
        // Exit 2 = block, stderr is the user-facing reason.
        if (result.code === 2) {
          return {
            decision: 'block',
            reason: shortenStderr(result.stderr) || `hook ${h.command} exited 2 with no stderr`,
            hookCommand: h.command
          };
        }
        // Exit 0: parse stdout for a JSON decision.
        if (result.code === 0) {
          const dec = parseDecision(result.stdout);
          if (dec) {
            return { decision: 'block', reason: dec.reason, hookCommand: h.command };
          }
          continue;
        }
        // Other exit codes (1, 3+): non-blocking warning — log first line of stderr.
        const firstLine = result.stderr.split('\n').find((l) => l.trim().length > 0) ?? '';
        this.log(`HookRunner: ${h.command} exited ${result.code} (non-blocking) — ${firstLine}`);
      }
    }
    return { decision: 'allow' };
  }
}
