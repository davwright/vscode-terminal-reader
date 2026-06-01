export interface NumberedLine {
  lineNumber: number;
  text: string;
}

export class RingBuffer {
  private lines: string[] = [];
  private partial = '';
  // 1-based line number of `lines[0]`. Increases when the ring drops oldest
  // lines, so callers always get stable, ever-growing line numbers.
  private firstLineNumber = 1;

  constructor(private readonly maxLines: number) {}

  append(chunk: string): void {
    this.partial += chunk;
    let nl = this.partial.indexOf('\n');
    while (nl !== -1) {
      let line = this.partial.slice(0, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.lines.push(line);
      this.partial = this.partial.slice(nl + 1);
      nl = this.partial.indexOf('\n');
    }
    this.evictIfNeeded();
  }

  flushPartial(): void {
    if (this.partial.length > 0) {
      this.lines.push(this.partial);
      this.partial = '';
      this.evictIfNeeded();
    }
  }

  private evictIfNeeded(): void {
    const overflow = this.lines.length - this.maxLines;
    if (overflow > 0) {
      this.lines.splice(0, overflow);
      this.firstLineNumber += overflow;
    }
  }

  /**
   * Read lines with stable 1-based line numbers.
   *
   * Selection options (combined: range first, then grep filter, then tail):
   * - `range: [start, end]` (inclusive, 1-based) — slice by absolute line numbers
   * - `grep` + optional `grepFlags` — filter to matching lines; `context` adds
   *   N lines of before/after around each match (deduplicated)
   * - `tail` — last N lines after grep/range
   */
  read(opts: {
    tail?: number;
    grep?: string;
    grepFlags?: string;
    range?: [number, number];
    context?: number;
  } = {}): NumberedLine[] {
    const all: NumberedLine[] = this.lines.map((text, i) => ({
      lineNumber: this.firstLineNumber + i,
      text
    }));
    let out = all;

    if (opts.range) {
      const [start, end] = opts.range;
      out = out.filter((l) => l.lineNumber >= start && l.lineNumber <= end);
    }

    if (opts.grep) {
      const re = new RegExp(opts.grep, opts.grepFlags ?? 'i');
      const ctx = Math.max(0, opts.context ?? 0);
      if (ctx === 0) {
        out = out.filter((l) => re.test(l.text));
      } else {
        const keep = new Set<number>();
        for (let i = 0; i < out.length; i++) {
          if (re.test(out[i].text)) {
            for (let j = Math.max(0, i - ctx); j <= Math.min(out.length - 1, i + ctx); j++) {
              keep.add(j);
            }
          }
        }
        out = out.filter((_, i) => keep.has(i));
      }
    }

    if (opts.tail && opts.tail > 0 && out.length > opts.tail) {
      out = out.slice(out.length - opts.tail);
    }
    return out;
  }

  size(): number {
    return this.lines.length;
  }

  /** 1-based line number of the next line that will be appended. */
  nextLineNumber(): number {
    return this.firstLineNumber + this.lines.length;
  }

  clear(): void {
    // Advance past discarded lines so subsequent appends get fresh numbers,
    // never the same numbers the cleared lines had. clear() is a special
    // case of eviction — same invariant applies.
    this.firstLineNumber += this.lines.length;
    this.lines = [];
    this.partial = '';
  }
}

// Terminal escape sequences. VSCode's shell integration emits OSC 633
// (e.g. ESC ] 633 ; C BEL) as command markers; the previous CSI-only regex
// missed those, leaking control sequences into stripped output.
//
// OSC: ESC ] ... (BEL | ESC \)
// CSI: ESC [ params? intermediates? final
// Two-byte: ESC followed by a single byte from @-_ (covers SS2/SS3, etc.)
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
