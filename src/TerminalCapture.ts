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
  name: string;
  format: 'json';
  totalLines: number;
  lines: NumberedLine[];
}

export interface TextReadResult {
  name: string;
  format: 'text';
  totalLines: number;
  text: string;
}

export interface RawReadResult {
  name: string;
  format: 'raw';
  totalBytes: number;
  text: string;
}

export type ReadResult = JsonReadResult | TextReadResult | RawReadResult;

export interface TerminalState {
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
}

const RAW_BUFFER_MAX_BYTES = 1024 * 1024; // 1 MiB rolling raw stream per terminal

export class TerminalCapture implements vscode.Disposable {
  private readonly entries = new Map<vscode.Terminal, TerminalEntry>();
  private readonly disposables: vscode.Disposable[] = [];

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
      })
    );
  }

  private track(terminal: vscode.Terminal): void {
    if (this.entries.has(terminal)) return;
    this.entries.set(terminal, {
      terminal,
      buffer: new RingBuffer(this.maxLines()),
      rawBuffer: '',
      rawBytes: 0,
      shellIntegrationActive: !!terminal.shellIntegration,
      busy: false
    });
  }

  private appendRaw(entry: TerminalEntry, chunk: string): void {
    entry.rawBuffer += chunk;
    entry.rawBytes += chunk.length;
    if (entry.rawBuffer.length > RAW_BUFFER_MAX_BYTES) {
      const overflow = entry.rawBuffer.length - RAW_BUFFER_MAX_BYTES;
      entry.rawBuffer = entry.rawBuffer.slice(overflow);
    }
  }

  private resolve(target: { name?: string; index?: number }): TerminalEntry | undefined {
    const list = Array.from(this.entries.values());
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
    name: string;
    cwd: string | undefined;
    shellIntegration: boolean;
    bufferLines: number;
    busy: boolean;
    lastCommand?: string;
    lastExitCode?: number;
  }> {
    return Array.from(this.entries.values()).map((e) => ({
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
    target: { name?: string; index?: number },
    opts: ReadOpts = {}
  ): ReadResult | { error: string } {
    const entry = this.resolve(target);
    if (!entry) return { error: 'terminal not found' };
    return this.formatRead(entry, opts);
  }

  readAll(opts: ReadOpts = {}): ReadResult[] {
    return Array.from(this.entries.values()).map((entry) => this.formatRead(entry, opts));
  }

  state(target: { name?: string; index?: number } = {}): TerminalState | { error: string } {
    const entry = this.resolve(target);
    if (!entry) return { error: 'terminal not found' };
    return {
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
  interrupt(target: { name?: string; index?: number } = {}): { sent: boolean; name?: string; reason?: string } {
    const entry = this.resolve(target);
    if (!entry) return { sent: false, reason: 'terminal not found' };
    try {
      entry.terminal.sendText('\x03', false);
      return { sent: true, name: entry.terminal.name };
    } catch (e: any) {
      return { sent: false, reason: e?.message ?? String(e) };
    }
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
      return { name: entry.terminal.name, format: 'json', totalLines, lines };
    }

    // 'text' format: pipe-separated, padded line numbers. Padding width tracks
    // the largest number in this batch so columns align without padding to
    // the buffer's full size every time.
    const maxNum = lines.length > 0 ? lines[lines.length - 1].lineNumber : 1;
    const width = Math.max(4, String(maxNum).length);
    const text = lines.map((l) => `${String(l.lineNumber).padStart(width)} | ${l.text}`).join('\n');
    return { name: entry.terminal.name, format: 'text', totalLines, text };
  }

  clear(target?: { name?: string; index?: number; all?: boolean }): { cleared: string[] } {
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
