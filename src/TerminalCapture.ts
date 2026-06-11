import * as vscode from 'vscode';
import { RingBuffer, NumberedLine, stripAnsi } from './RingBuffer';

export type ReadFormat = 'json' | 'text' | 'raw';

export interface ReadOpts {
  tail?: number;
  grep?: string;
  grepFlags?: string;
  range?: [number, number];
  context?: number;
  stripAnsi?: boolean;
  format?: ReadFormat;
}

export interface JsonReadResult {
  id: number;
  name: string;
  format: 'json';
  totalLines: number;
  lines: NumberedLine[];
}

export interface TextReadResult {
  id: number;
  name: string;
  format: 'text';
  totalLines: number;
  text: string;
}

export interface RawReadResult {
  id: number;
  name: string;
  format: 'raw';
  totalBytes: number;
  text: string;
}

export type ReadResult = JsonReadResult | TextReadResult | RawReadResult;

export interface TerminalState {
  id: number;
  name: string;
  status: 'busy' | 'idle' | 'unknown';
  shellIntegration: boolean;
  lastCommand?: string;
  lastExitCode?: number;
  lastCommandStartedAt?: number;
  lastCommandFinishedAt?: number;
  bufferLines: number;
  totalLines: number;
  cwd?: string;
}

interface TerminalEntry {
  // Stable, monotonic id assigned when the terminal is first tracked. Unlike
  // `name` (which the shell/user can change) and the list index (which shifts as
  // terminals open/close), this never changes for the life of the terminal — so
  // a caller that captured an id can always re-target the exact same terminal.
  id: number;
  terminal: vscode.Terminal;
  buffer: RingBuffer;
  rawBuffer: string;
  rawBytes: number;
  shellIntegrationActive: boolean;
  busy: boolean;
  lastCommand?: string;
  lastExitCode?: number;
  lastCommandStartedAt?: number;
  lastCommandFinishedAt?: number;
  // Hooks fired by onDidEndTerminalShellExecution and appendRaw so waitForIdle
  // can resolve event-driven (no polling). Cleared after each fire — waiters
  // re-register themselves if they want subsequent events.
  endWaiters: Array<(exitCode: number | undefined) => void>;
  appendWaiters: Array<(chunk: string) => void>;
}

const RAW_BUFFER_MAX_BYTES = 1024 * 1024; // 1 MiB rolling raw stream per terminal

export class TerminalCapture implements vscode.Disposable {
  private readonly entries = new Map<vscode.Terminal, TerminalEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private nextId = 1;

  constructor(private readonly maxLines: () => number) {
    for (const t of vscode.window.terminals) this.track(t);

    this.disposables.push(
      vscode.window.onDidOpenTerminal((t) => this.track(t)),
      vscode.window.onDidCloseTerminal((t) => this.entries.delete(t)),
      vscode.window.onDidChangeTerminalShellIntegration((e) => {
        const entry = this.entries.get(e.terminal);
        if (entry) entry.shellIntegrationActive = true;
      }),
      vscode.window.onDidStartTerminalShellExecution((e) => {
        const entry = this.entries.get(e.terminal);
        if (!entry) return;
        entry.lastCommand = e.execution.commandLine.value;
        entry.lastCommandStartedAt = Date.now();
        entry.lastCommandFinishedAt = undefined;
        entry.busy = true;
        const startMarker = `\n▶ ${entry.lastCommand}\n`;
        entry.buffer.append(startMarker);
        this.appendRaw(entry, startMarker);
        const stream = e.execution.read();
        (async () => {
          try {
            for await (const chunk of stream) {
              entry.buffer.append(chunk);
              this.appendRaw(entry, chunk);
            }
          } catch {
            // stream ended unexpectedly
          }
        })();
      }),
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const entry = this.entries.get(e.terminal);
        if (!entry) return;
        entry.lastExitCode = e.exitCode;
        entry.lastCommandFinishedAt = Date.now();
        entry.busy = false;
        entry.buffer.flushPartial();
        const endMarker = `■ exit ${e.exitCode ?? '?'}\n`;
        entry.buffer.append(endMarker);
        this.appendRaw(entry, endMarker);
        if (entry.endWaiters.length) {
          const waiters = entry.endWaiters.splice(0);
          for (const w of waiters) w(e.exitCode);
        }
      })
    );
  }

  private track(terminal: vscode.Terminal): void {
    if (this.entries.has(terminal)) return;
    this.entries.set(terminal, {
      id: this.nextId++,
      terminal,
      buffer: new RingBuffer(this.maxLines()),
      rawBuffer: '',
      rawBytes: 0,
      shellIntegrationActive: !!terminal.shellIntegration,
      busy: false,
      endWaiters: [],
      appendWaiters: []
    });
  }

  private appendRaw(entry: TerminalEntry, chunk: string): void {
    entry.rawBuffer += chunk;
    entry.rawBytes += chunk.length;
    if (entry.rawBuffer.length > RAW_BUFFER_MAX_BYTES) {
      const overflow = entry.rawBuffer.length - RAW_BUFFER_MAX_BYTES;
      entry.rawBuffer = entry.rawBuffer.slice(overflow);
    }
    if (entry.appendWaiters.length) {
      const waiters = entry.appendWaiters.splice(0);
      for (const w of waiters) w(chunk);
    }
  }

  private resolve(target: { id?: number; name?: string; index?: number }): TerminalEntry | undefined {
    const list = Array.from(this.entries.values());
    // id wins — it's the only target that can't be aliased by a rename or shifted
    // by another terminal opening/closing. Name is next (human-friendly but can
    // collide or change), then index (positional, least stable).
    if (typeof target.id === 'number') return list.find((e) => e.id === target.id);
    if (target.name) return list.find((e) => e.terminal.name === target.name);
    if (typeof target.index === 'number') return list[target.index];
    // Default: most recently active. The active terminal is the user's focus
    // or the most recently created one, in that order.
    const active = vscode.window.activeTerminal;
    if (active) {
      const found = list.find((e) => e.terminal === active);
      if (found) return found;
    }
    return list[list.length - 1];
  }

  list(): Array<{
    id: number;
    name: string;
    cwd: string | undefined;
    shellIntegration: boolean;
    bufferLines: number;
    busy: boolean;
    lastCommand?: string;
    lastExitCode?: number;
  }> {
    return Array.from(this.entries.values()).map((e) => ({
      id: e.id,
      name: e.terminal.name,
      cwd: e.terminal.shellIntegration?.cwd?.fsPath,
      shellIntegration: e.shellIntegrationActive,
      bufferLines: e.buffer.size(),
      busy: e.busy,
      lastCommand: e.lastCommand,
      lastExitCode: e.lastExitCode
    }));
  }

  read(
    target: { id?: number; name?: string; index?: number },
    opts: ReadOpts = {}
  ): ReadResult | { error: string } {
    const entry = this.resolve(target);
    if (!entry) return { error: 'terminal not found' };
    return this.formatRead(entry, opts);
  }

  readAll(opts: ReadOpts = {}): ReadResult[] {
    return Array.from(this.entries.values()).map((entry) => this.formatRead(entry, opts));
  }

  state(target: { id?: number; name?: string; index?: number } = {}): TerminalState | { error: string } {
    const entry = this.resolve(target);
    if (!entry) return { error: 'terminal not found' };
    return {
      id: entry.id,
      name: entry.terminal.name,
      status: entry.shellIntegrationActive ? (entry.busy ? 'busy' : 'idle') : 'unknown',
      shellIntegration: entry.shellIntegrationActive,
      lastCommand: entry.lastCommand,
      lastExitCode: entry.lastExitCode,
      lastCommandStartedAt: entry.lastCommandStartedAt,
      lastCommandFinishedAt: entry.lastCommandFinishedAt,
      bufferLines: entry.buffer.size(),
      totalLines: entry.buffer.nextLineNumber() - 1,
      cwd: entry.terminal.shellIntegration?.cwd?.fsPath
    };
  }

  /**
   * Send Ctrl-C (ETX, 0x03) to the terminal. Not gated by any allowlist —
   * Ctrl-C is a safety primitive, the user always wants the LLM to be able
   * to abort a runaway command.
   */
  interrupt(target: { id?: number; name?: string; index?: number } = {}): { sent: boolean; name?: string; reason?: string } {
    const entry = this.resolve(target);
    if (!entry) return { sent: false, reason: 'terminal not found' };
    try {
      entry.terminal.sendText('\x03', false);
      return { sent: true, name: entry.terminal.name };
    } catch (e: any) {
      return { sent: false, reason: e?.message ?? String(e) };
    }
  }

  /**
   * Current working directory of the target terminal, when shell integration
   * has reported one. Returns undefined when integration is off or hasn't yet
   * fired a CWD update.
   */
  cwdOf(target: { id?: number; name?: string; index?: number } = {}): string | undefined {
    const entry = this.resolve(target);
    return entry?.terminal.shellIntegration?.cwd?.fsPath;
  }

  /**
   * Detect the shell of a target terminal. Uses creationOptions.shellPath
   * when available, falling back to the platform default. Returns 'bash'
   * if detection fails — see Permissions for the namespace mapping.
   */
  detectShell(target: { id?: number; name?: string; index?: number } = {}): 'powershell' | 'bash' | null {
    const entry = this.resolve(target);
    if (!entry) return null;
    const opts = entry.terminal.creationOptions as { shellPath?: string } | undefined;
    const shellPath = opts?.shellPath?.toLowerCase() ?? '';
    if (shellPath.includes('pwsh') || shellPath.includes('powershell')) return 'powershell';
    if (shellPath.includes('bash') || shellPath.includes('zsh') || shellPath.includes('sh') || shellPath.includes('fish')) {
      return 'bash';
    }
    // No explicit shellPath: fall back to platform default. On Windows the
    // default integrated terminal is PowerShell; elsewhere it's bash-family.
    return process.platform === 'win32' ? 'powershell' : 'bash';
  }

  /**
   * Send a command to the target terminal after the caller has already
   * approved it. Returns the line number where the command's output will
   * begin, so the caller can subsequently terminal_read({range:[runId, ...]})
   * to slice exactly this run's output. Buffer clear is the caller's
   * responsibility — this method does no permission checking and no clearing.
   */
  run(
    target: { id?: number; name?: string; index?: number },
    command: string,
    addNewline: boolean
  ): { sent: boolean; name?: string; runId?: number; reason?: string } {
    const entry = this.resolve(target);
    if (!entry) return { sent: false, reason: 'terminal not found' };
    const runId = entry.buffer.nextLineNumber();
    try {
      entry.terminal.sendText(command, addNewline);
      return { sent: true, name: entry.terminal.name, runId };
    } catch (e: any) {
      return { sent: false, reason: e?.message ?? String(e) };
    }
  }

  /**
   * Block until the target terminal finishes its current command, a pattern
   * matches new output, the timeout elapses, or (when returnOnNonZeroExitFast)
   * a non-zero exit is reported.
   *
   * Event-driven via onDidEndTerminalShellExecution + appendRaw hooks — no
   * polling. Resolves quickly if the terminal is already idle.
   *
   * Shell integration off → resolves `reason: 'unsupported'` immediately,
   * because OSC 633 D-marks are the only reliable end-of-command signal.
   */
  async waitForIdle(
    target: { id?: number; name?: string; index?: number },
    opts: {
      timeoutMs: number;
      returnOnPattern?: string;
      returnOnPatternFlags?: string;
      // Lines below this number are ignored for pattern matching. Use the
      // runId returned by run() so we don't match against pre-existing output.
      patternStartLine?: number;
    }
  ): Promise<{
    reason: 'finished' | 'pattern' | 'timeout' | 'unsupported' | 'invalid-pattern';
    name?: string;
    exitCode?: number;
    matchedLine?: { lineNumber: number; text: string };
    totalLines: number;
    elapsedMs: number;
    error?: string;
  }> {
    const entry = this.resolve(target);
    if (!entry) {
      return { reason: 'timeout', totalLines: 0, elapsedMs: 0 };
    }
    const started = Date.now();
    const totalNow = () => entry.buffer.nextLineNumber() - 1;
    if (!entry.shellIntegrationActive) {
      return {
        reason: 'unsupported',
        name: entry.terminal.name,
        totalLines: totalNow(),
        elapsedMs: 0
      };
    }
    // Already idle, and not waiting for a pattern? Return immediately.
    if (!entry.busy && !opts.returnOnPattern) {
      return {
        reason: 'finished',
        name: entry.terminal.name,
        exitCode: entry.lastExitCode,
        totalLines: totalNow(),
        elapsedMs: 0
      };
    }

    // Compile defensively — a bad regex from the caller shouldn't crash the
    // IPC. Return a clean typed error instead.
    let re: RegExp | null = null;
    if (opts.returnOnPattern) {
      try {
        re = new RegExp(opts.returnOnPattern, opts.returnOnPatternFlags ?? 'i');
      } catch (e: any) {
        return {
          reason: 'invalid-pattern',
          name: entry.terminal.name,
          error: e?.message ?? String(e),
          totalLines: totalNow(),
          elapsedMs: Date.now() - started
        };
      }
    }
    // ANSI escapes are stored in the buffer as-is (stripping happens on read).
    // Strip before testing so patterns like /^error/ don't trip over a leading
    // \x1b[31m. Substring matches still work either way.
    const testLine = (text: string) => re!.test(stripAnsi(text));
    // Scan output already buffered between patternStartLine and now — the caller
    // may have run a command and we may already have new output before
    // waitForIdle is entered (the bridge → IPC hop is async). When no
    // patternStartLine is supplied, scan from the buffer's first line — better
    // to match a line we shouldn't have seen than to miss the only match.
    if (re) {
      const startFrom = opts.patternStartLine ?? 1;
      const existing = entry.buffer.read({ range: [startFrom, totalNow()] });
      for (const l of existing) {
        if (testLine(l.text)) {
          return {
            reason: 'pattern',
            name: entry.terminal.name,
            matchedLine: l,
            totalLines: totalNow(),
            elapsedMs: Date.now() - started
          };
        }
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Parameters<typeof resolve>[0]) => {
        if (settled) return;
        settled = true;
        // Best-effort cleanup — splice the waiter slots so a long-lived terminal
        // doesn't accumulate stale entries from timed-out waits.
        const ei = entry.endWaiters.indexOf(onEnd);
        if (ei >= 0) entry.endWaiters.splice(ei, 1);
        const ai = entry.appendWaiters.indexOf(onAppend);
        if (ai >= 0) entry.appendWaiters.splice(ai, 1);
        clearTimeout(timer);
        resolve(result);
      };
      const onEnd = (exitCode: number | undefined) => {
        finish({
          reason: 'finished',
          name: entry.terminal.name,
          exitCode,
          totalLines: totalNow(),
          elapsedMs: Date.now() - started
        });
      };
      const onAppend = (_chunk: string) => {
        if (!re) return;
        // Re-register so we keep getting notifications until we settle.
        if (!settled) entry.appendWaiters.push(onAppend);
        // Scan newly appended lines from patternStartLine (or buffer start) to
        // now. RingBuffer.read with a range is cheap — O(n) over the slice.
        const startFrom = opts.patternStartLine ?? 1;
        const recent = entry.buffer.read({ range: [startFrom, totalNow()] });
        for (const l of recent) {
          if (testLine(l.text)) {
            finish({
              reason: 'pattern',
              name: entry.terminal.name,
              matchedLine: l,
              totalLines: totalNow(),
              elapsedMs: Date.now() - started
            });
            return;
          }
        }
      };
      entry.endWaiters.push(onEnd);
      // Only register the append listener when we actually have a pattern —
      // otherwise we'd accumulate a no-op listener that just re-registers
      // itself on every chunk.
      if (re) entry.appendWaiters.push(onAppend);
      const timer = setTimeout(() => {
        finish({
          reason: 'timeout',
          name: entry.terminal.name,
          totalLines: totalNow(),
          elapsedMs: Date.now() - started
        });
      }, opts.timeoutMs);
    });
  }

  private formatRead(entry: TerminalEntry, opts: ReadOpts): ReadResult {
    const format = opts.format ?? 'text';
    const totalLines = entry.buffer.nextLineNumber() - 1;

    if (format === 'raw') {
      // Raw stream — never strip ANSI/OSC, so OSC 633 markers and colours are
      // preserved for callers that want to parse them themselves. grep, tail,
      // and context all work on lines; the bytes within each kept line are
      // untouched. range is intentionally not supported on raw because the
      // raw buffer is byte-bounded (1 MiB) rather than line-numbered.
      let lines = entry.rawBuffer.split('\n');
      if (opts.grep) {
        const re = new RegExp(opts.grep, opts.grepFlags ?? 'i');
        const ctx = Math.max(0, opts.context ?? 0);
        if (ctx === 0) {
          lines = lines.filter((l) => re.test(l));
        } else {
          const keep = new Set<number>();
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) {
                keep.add(j);
              }
            }
          }
          lines = lines.filter((_, i) => keep.has(i));
        }
      }
      if (opts.tail && opts.tail > 0 && lines.length > opts.tail) {
        lines = lines.slice(-opts.tail);
      }
      return {
        id: entry.id,
        name: entry.terminal.name,
        format: 'raw',
        totalBytes: entry.rawBytes,
        text: lines.join('\n')
      };
    }

    const matches = entry.buffer.read({
      tail: opts.tail,
      grep: opts.grep,
      grepFlags: opts.grepFlags,
      range: opts.range,
      context: opts.context
    });
    const lines =
      opts.stripAnsi !== false
        ? matches.map((m) => ({ lineNumber: m.lineNumber, text: stripAnsi(m.text) }))
        : matches;

    if (format === 'json') {
      return { id: entry.id, name: entry.terminal.name, format: 'json', totalLines, lines };
    }

    // 'text' format: pipe-separated, padded line numbers. Padding width tracks
    // the largest number in this batch so columns align without padding to
    // the buffer's full size every time.
    const maxNum = lines.length > 0 ? lines[lines.length - 1].lineNumber : 1;
    const width = Math.max(4, String(maxNum).length);
    const text = lines.map((l) => `${String(l.lineNumber).padStart(width)} | ${l.text}`).join('\n');
    return { id: entry.id, name: entry.terminal.name, format: 'text', totalLines, text };
  }

  clear(target?: { id?: number; name?: string; index?: number; all?: boolean }): { cleared: string[] } {
    if (!target || target.all) {
      const names: string[] = [];
      for (const e of this.entries.values()) {
        e.buffer.clear();
        e.rawBuffer = '';
        names.push(e.terminal.name);
      }
      return { cleared: names };
    }
    const entry = this.resolve({ name: target.name, index: target.index });
    if (!entry) return { cleared: [] };
    entry.buffer.clear();
    entry.rawBuffer = '';
    return { cleared: [entry.terminal.name] };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.entries.clear();
  }
}
