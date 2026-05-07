import * as vscode from 'vscode';
import { RingBuffer, NumberedLine, stripAnsi } from './RingBuffer';

export interface ReadOpts {
  tail?: number;
  grep?: string;
  range?: [number, number];
  context?: number;
  stripAnsi?: boolean;
}

export interface ReadResult {
  name: string;
  totalLines: number;
  lines: NumberedLine[];
}

interface TerminalEntry {
  terminal: vscode.Terminal;
  buffer: RingBuffer;
  shellIntegrationActive: boolean;
  lastCommand?: string;
  lastExitCode?: number;
  lastCommandStartedAt?: number;
}

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
        entry.buffer.append(`\n▶ ${entry.lastCommand}\n`);
        const stream = e.execution.read();
        (async () => {
          try {
            for await (const chunk of stream) {
              entry.buffer.append(chunk);
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
        entry.buffer.flushPartial();
        entry.buffer.append(`■ exit ${e.exitCode ?? '?'}\n`);
      })
    );
  }

  private track(terminal: vscode.Terminal): void {
    if (this.entries.has(terminal)) return;
    this.entries.set(terminal, {
      terminal,
      buffer: new RingBuffer(this.maxLines()),
      shellIntegrationActive: !!terminal.shellIntegration
    });
  }

  list(): Array<{
    name: string;
    pid: number | undefined;
    cwd: string | undefined;
    shellIntegration: boolean;
    bufferLines: number;
    lastCommand?: string;
    lastExitCode?: number;
  }> {
    return Array.from(this.entries.values()).map((e) => ({
      name: e.terminal.name,
      pid: undefined,
      cwd: e.terminal.shellIntegration?.cwd?.fsPath,
      shellIntegration: e.shellIntegrationActive,
      bufferLines: e.buffer.size(),
      lastCommand: e.lastCommand,
      lastExitCode: e.lastExitCode
    }));
  }

  read(
    target: { name?: string; index?: number },
    opts: ReadOpts = {}
  ): ReadResult | { error: string } {
    const list = Array.from(this.entries.values());
    let entry: TerminalEntry | undefined;
    if (target.name) {
      entry = list.find((e) => e.terminal.name === target.name);
    } else if (typeof target.index === 'number') {
      entry = list[target.index];
    } else {
      entry = list[list.length - 1];
    }
    if (!entry) return { error: 'terminal not found' };
    return this.formatRead(entry, opts);
  }

  readAll(opts: ReadOpts = {}): ReadResult[] {
    return Array.from(this.entries.values()).map((entry) => this.formatRead(entry, opts));
  }

  private formatRead(entry: TerminalEntry, opts: ReadOpts): ReadResult {
    const matches = entry.buffer.read({
      tail: opts.tail,
      grep: opts.grep,
      range: opts.range,
      context: opts.context
    });
    const stripped =
      opts.stripAnsi !== false
        ? matches.map((m) => ({ lineNumber: m.lineNumber, text: stripAnsi(m.text) }))
        : matches;
    return {
      name: entry.terminal.name,
      totalLines: entry.buffer.nextLineNumber() - 1,
      lines: stripped
    };
  }

  clear(): void {
    for (const e of this.entries.values()) e.buffer.clear();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.entries.clear();
  }
}
