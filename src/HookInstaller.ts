// Vendors the user's two unhomed PreToolUse/Bash hook scripts
// (block-git-write.sh, block-python.sh) and keeps them "hot" — installed in
// ~/.claude/hooks/ and registered in ~/.claude/settings.json.
//
// Why this exists: the user's hook scripts had no upstream until now. They
// lived only in ~/.claude/hooks/. Shipping them with this extension means a
// fresh machine + this VSIX = the protections come back online automatically.
//
// Versioning: each bundled script carries a header line of the form
//   # vscode-terminal-reader-hook: name=<name> version=<n>
// On every activate(): if the bundled version > the installed version (or the
// installed file is missing), overwrite. If the installed version is >= the
// bundled version, leave it alone — we don't downgrade. Settings.json is
// reconciled similarly: PreToolUse/Bash entries are added if missing or have
// an older canonical shape; existing matching entries are left in place.
//
// What this does NOT touch:
//   - block-ev-customer-writes.sh — that script and its settings entry belong
//     to the EvolxCli repo. This installer ignores them entirely.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface InstalledHook {
  name: string;
  version: number;
  bundledPath: string;
  installedPath: string;
  installed: boolean; // true if we wrote/replaced the file in this run
}

interface BundledHook {
  name: string;
  version: number;
  bundledPath: string;
  content: string;
}

const HEADER_PREFIX = '# vscode-terminal-reader-hook:';

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? os.homedir();
}

function hooksDir(): string {
  return path.join(claudeDir(), '.claude', 'hooks');
}

function settingsPath(): string {
  return path.join(claudeDir(), '.claude', 'settings.json');
}

/**
 * Parse the version header out of a script's content. Returns version 0 when
 * the header is missing or malformed — that's the "treat as ancient" case so
 * the first install always wins.
 */
function parseHeader(content: string): { name: string | null; version: number } {
  const lines = content.split(/\r?\n/, 20); // header must be in the first 20 lines
  for (const line of lines) {
    if (!line.startsWith(HEADER_PREFIX)) continue;
    const rest = line.slice(HEADER_PREFIX.length).trim();
    const parts = rest.split(/\s+/);
    let name: string | null = null;
    let version = 0;
    for (const kv of parts) {
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (k === 'name') name = v;
      else if (k === 'version') {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0) version = n;
      }
    }
    return { name, version };
  }
  return { name: null, version: 0 };
}

function readBundledHooks(extensionPath: string): BundledHook[] {
  const dir = path.join(extensionPath, 'hooks');
  if (!fs.existsSync(dir)) return [];
  const out: BundledHook[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.sh')) continue;
    const full = path.join(dir, entry);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const { name, version } = parseHeader(content);
    if (!name) continue; // un-versioned bundled file → skip rather than risk overwriting
    out.push({ name, version, bundledPath: full, content });
  }
  return out;
}

function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + `.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
  // Best-effort: make executable. Irrelevant on Windows when spawned via `bash`,
  // but free to include for any cross-platform future.
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // ignore — chmod is not supported on every filesystem
  }
}

function readSettings(): any {
  const file = settingsPath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeSettings(data: any): void {
  // Atomic write — settings.json may be open by Claude Code. Match the pattern
  // used for ~/.claude.json in extension.ts.
  const target = settingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + `.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

function sameInstalledPath(commandStr: string, installedPath: string): boolean {
  // The settings entry's `command` may be `~/.claude/hooks/foo.sh` or an
  // absolute path. Compare after tilde expansion and realpath where possible.
  let head = commandStr;
  const firstSpace = head.search(/\s/);
  if (firstSpace !== -1) head = head.slice(0, firstSpace);
  if (head.startsWith('"') || head.startsWith("'")) head = head.slice(1, -1);
  if (head.startsWith('~/') || head.startsWith('~\\')) {
    head = path.join(os.homedir(), head.slice(2));
  }
  try {
    return path.resolve(head).toLowerCase() === path.resolve(installedPath).toLowerCase();
  } catch {
    return head === installedPath;
  }
}

export class HookInstaller {
  constructor(
    private readonly extensionPath: string,
    private readonly log: (msg: string) => void = (m) => process.stderr.write(`[vscode-tr] ${m}\n`)
  ) {}

  /**
   * Run the install pass once. Idempotent; safe to call on every activation.
   * Returns the list of hooks the installer is responsible for, with their
   * resolved state — useful for the status bar to show what's vendored vs
   * what's third-party.
   */
  async install(): Promise<InstalledHook[]> {
    const bundled = readBundledHooks(this.extensionPath);
    if (bundled.length === 0) return [];

    const results: InstalledHook[] = [];
    const installedNames = new Set<string>();

    for (const b of bundled) {
      const target = path.join(hooksDir(), `${b.name}.sh`);
      let didInstall = false;
      let installedVersion = -1;
      if (fs.existsSync(target)) {
        try {
          const onDisk = fs.readFileSync(target, 'utf8');
          installedVersion = parseHeader(onDisk).version;
        } catch (e: any) {
          this.log(`HookInstaller: failed to read ${target}: ${e?.message ?? e}`);
        }
      }
      if (installedVersion < b.version) {
        try {
          atomicWrite(target, b.content);
          didInstall = true;
          this.log(
            `HookInstaller: installed ${b.name} v${b.version} -> ${target} (was v${installedVersion < 0 ? 'absent' : installedVersion})`
          );
        } catch (e: any) {
          this.log(`HookInstaller: failed to write ${target}: ${e?.message ?? e}`);
        }
      }
      results.push({
        name: b.name,
        version: b.version,
        bundledPath: b.bundledPath,
        installedPath: target,
        installed: didInstall
      });
      installedNames.add(b.name);
    }

    this.reconcileSettings(results);
    return results;
  }

  /**
   * Public surface used by the status bar to enumerate the vendored hooks
   * without re-running the install pass.
   */
  listBundled(): Array<{ name: string; version: number; installedPath: string }> {
    return readBundledHooks(this.extensionPath).map((b) => ({
      name: b.name,
      version: b.version,
      installedPath: path.join(hooksDir(), `${b.name}.sh`)
    }));
  }

  private reconcileSettings(installed: InstalledHook[]): void {
    const data = readSettings();
    if (!data) {
      this.log(
        'HookInstaller: ~/.claude/settings.json missing or unparseable — leaving file alone. Hooks will not fire until Claude Code is configured.'
      );
      return;
    }
    data.hooks = data.hooks ?? {};
    const preToolUse = (data.hooks.PreToolUse = Array.isArray(data.hooks.PreToolUse) ? data.hooks.PreToolUse : []);

    // Locate (or create) the matcher: "Bash" group exactly. We don't fold our
    // entries into a wildcard "*" group — those exist for things like the
    // heartbeat hook and shouldn't gain blocking entries by accident.
    let bashGroup = preToolUse.find((g: any) => g && g.matcher === 'Bash');
    if (!bashGroup) {
      bashGroup = { matcher: 'Bash', hooks: [] };
      preToolUse.push(bashGroup);
    }
    bashGroup.hooks = Array.isArray(bashGroup.hooks) ? bashGroup.hooks : [];

    let dirty = false;
    for (const h of installed) {
      const canonical = {
        type: 'command',
        command: `~/.claude/hooks/${h.name}.sh`,
        timeout: 10
      };
      const existingIndex = bashGroup.hooks.findIndex(
        (e: any) => e && e.type === 'command' && typeof e.command === 'string' && sameInstalledPath(e.command, h.installedPath)
      );
      if (existingIndex < 0) {
        bashGroup.hooks.push(canonical);
        dirty = true;
        this.log(`HookInstaller: added settings.json entry for ${h.name}`);
        continue;
      }
      // Entry exists. Only normalise if we just bumped the script version —
      // otherwise the user's local tweaks to timeout etc. are respected.
      if (h.installed) {
        const cur = bashGroup.hooks[existingIndex];
        const replaced = { ...cur, type: 'command', command: canonical.command };
        if (typeof cur.timeout !== 'number' || cur.timeout <= 0) replaced.timeout = canonical.timeout;
        if (JSON.stringify(cur) !== JSON.stringify(replaced)) {
          bashGroup.hooks[existingIndex] = replaced;
          dirty = true;
          this.log(`HookInstaller: normalised settings.json entry for ${h.name}`);
        }
      }
    }
    if (dirty) {
      try {
        writeSettings(data);
      } catch (e: any) {
        this.log(`HookInstaller: failed to write settings.json: ${e?.message ?? e}`);
      }
    }
  }
}
