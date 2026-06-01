// Minimal subset of Claude Code's permission system for terminal_run.
// Reads a single workspace-local file: <workspaceRoot>/.claude/settings.local.json
// and consumes its `permissions.allow` and `permissions.deny` arrays.
//
// Intentionally NOT implemented (see issue #3 for the full spec):
//   - User-level (~/.claude/settings.json) and managed/policy layers
//   - `permissions.ask` (treated as deny — no UI to prompt through MCP)
//   - Process wrapper stripping (timeout, time, nice, nohup, stdbuf, xargs)
//   - Always-prompt wrapper exact-match enforcement (watch, find -exec, etc.)
//   - PowerShell alias canonicalisation (gci → Get-ChildItem)
//   - Read-only command auto-approve list (ls, cat, grep, …)
//   - VSCode output channel "Terminal Reader (audit)" — using stderr instead
//   - fs.watch hot reload — settings re-read on every evaluate() call
//
// Re-reading on every call is cheap (a small JSON file) and avoids the entire
// class of stale-cache and watcher-leak bugs that hot-reload introduces.

import * as fs from 'fs';
import * as path from 'path';

export type Shell = 'powershell' | 'bash';
export type Decision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string; rule?: string; source?: string };

interface ParsedRule {
  namespace: 'Bash' | 'PowerShell';
  pattern: string; // empty string = bare namespace = wildcard
  raw: string;
}

const COMPOUND_SEPARATORS = /(?:&&|\|\||;|\|&|\||&|\n)/;

/**
 * Parse a single rule string like "Bash(npm run *)" or "PowerShell" into
 * its parts. Returns null for anything that isn't a Bash/PowerShell rule
 * (Read/Edit/etc. are silently ignored — they aren't terminal_run rules).
 */
export function parseRule(raw: string): ParsedRule | null {
  const trimmed = raw.trim();
  // Bare namespace: "Bash" or "PowerShell" — wildcard match.
  if (trimmed === 'Bash' || trimmed === 'PowerShell') {
    return { namespace: trimmed, pattern: '', raw };
  }
  const m = /^(Bash|PowerShell)\(([\s\S]*)\)$/.exec(trimmed);
  if (!m) return null;
  return { namespace: m[1] as 'Bash' | 'PowerShell', pattern: m[2], raw };
}

/**
 * Split a command on Claude Code's compound separators. Each piece must
 * pass the rule check independently — `safe-cmd && evil` must NOT be
 * approved by `Bash(safe-cmd)` alone.
 *
 * Note: this is naive — it doesn't respect quoted strings or escapes.
 * That matches Claude Code's own conservative behaviour: when in doubt,
 * split, because a false split errs on the side of more deny checks.
 */
export function splitCompound(command: string): string[] {
  return command
    .split(COMPOUND_SEPARATORS)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Match a command against a rule pattern using Claude Code's grammar:
 *   - `*` matches any character sequence (including spaces)
 *   - empty pattern (bare namespace) matches everything
 *   - `:*` suffix is shorthand for ` *` (trailing space + wildcard) per docs
 *   - case-insensitive for PowerShell, case-sensitive for Bash
 */
export function ruleMatches(pattern: string, command: string, shell: Shell): boolean {
  if (pattern === '') return true; // bare Bash/PowerShell
  // Normalise the `:*` suffix shorthand.
  const normalised = pattern.endsWith(':*')
    ? pattern.slice(0, -2) + ' *'
    : pattern;
  // Build a regex: escape everything, then turn escaped \* back into .*
  const escaped = normalised.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const flags = shell === 'powershell' ? 'i' : '';
  const re = new RegExp(`^${escaped}$`, flags);
  return re.test(command.trim());
}

interface SettingsShape {
  permissions?: {
    allow?: unknown;
    deny?: unknown;
  };
}

function readRules(file: string, log: (msg: string) => void): { allow: ParsedRule[]; deny: ParsedRule[] } {
  if (!fs.existsSync(file)) return { allow: [], deny: [] };
  let parsed: SettingsShape;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SettingsShape;
  } catch (e: any) {
    log(`Permissions: failed to parse ${file}: ${e?.message ?? e}. Treating as empty (default-deny).`);
    return { allow: [], deny: [] };
  }
  const allowRaw = Array.isArray(parsed?.permissions?.allow) ? (parsed.permissions!.allow as unknown[]) : [];
  const denyRaw = Array.isArray(parsed?.permissions?.deny) ? (parsed.permissions!.deny as unknown[]) : [];
  const allow: ParsedRule[] = [];
  const deny: ParsedRule[] = [];
  for (const r of allowRaw) {
    if (typeof r !== 'string') continue;
    const p = parseRule(r);
    if (p) allow.push(p);
  }
  for (const r of denyRaw) {
    if (typeof r !== 'string') continue;
    const p = parseRule(r);
    if (p) deny.push(p);
  }
  return { allow, deny };
}

export class Permissions {
  constructor(
    private readonly workspaceRoot: string | null,
    private readonly log: (msg: string) => void = (m) => process.stderr.write(`[vscode-tr] ${m}\n`)
  ) {}

  private settingsFile(): string | null {
    if (!this.workspaceRoot) return null;
    return path.join(this.workspaceRoot, '.claude', 'settings.local.json');
  }

  evaluate(command: string, shell: Shell): Decision {
    const file = this.settingsFile();
    if (!file) {
      return { decision: 'deny', reason: 'no workspace open — terminal_run requires a workspace folder' };
    }
    const { allow, deny } = readRules(file, this.log);
    const subcommands = splitCompound(command);
    if (subcommands.length === 0) {
      return { decision: 'deny', reason: 'empty command' };
    }
    const namespace = shell === 'powershell' ? 'PowerShell' : 'Bash';
    const relevantAllow = allow.filter((r) => r.namespace === namespace);
    const relevantDeny = deny.filter((r) => r.namespace === namespace);
    for (const sub of subcommands) {
      // deny first
      const d = relevantDeny.find((r) => ruleMatches(r.pattern, sub, shell));
      if (d) {
        return { decision: 'deny', reason: `denied by ${d.raw}`, rule: d.raw, source: file };
      }
      // then allow
      const a = relevantAllow.find((r) => ruleMatches(r.pattern, sub, shell));
      if (!a) {
        return {
          decision: 'deny',
          reason: `no matching allow rule for "${sub}" (namespace=${namespace})`,
          source: file
        };
      }
    }
    return { decision: 'allow' };
  }
}
