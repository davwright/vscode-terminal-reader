// Mirrors src/RingBuffer.ts semantics for console messages from the embedded
// browser. The numbering invariant is the same: 1-based, monotonic, stable,
// never reused across the buffer's lifetime — including across clear().
//
// Entries are structured (level/text/source/ts) but `read()` returns them
// in the same shape so callers can grep/range/tail/context them identically
// to terminal output.

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'other';

export interface ConsoleEntry {
  lineNumber: number;
  level: ConsoleLevel;
  text: string;
  source?: string;
  ts: number; // ms since epoch
}

export class ConsoleBuffer {
  private entries: ConsoleEntry[] = [];
  private firstLineNumber = 1;

  constructor(private readonly maxLines: number) {}

  push(level: ConsoleLevel, text: string, source?: string): void {
    const lineNumber = this.firstLineNumber + this.entries.length;
    this.entries.push({ lineNumber, level, text, source, ts: Date.now() });
    this.evictIfNeeded();
  }

  private evictIfNeeded(): void {
    const overflow = this.entries.length - this.maxLines;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
      this.firstLineNumber += overflow;
      // We mutated the array in place; lineNumbers in the surviving entries
      // are still correct because they were assigned at push time.
    }
  }

  read(
    opts: {
      tail?: number;
      grep?: string;
      grepFlags?: string;
      range?: [number, number];
      context?: number;
    } = {}
  ): ConsoleEntry[] {
    let out = this.entries.slice();
    if (opts.range) {
      const [start, end] = opts.range;
      out = out.filter((e) => e.lineNumber >= start && e.lineNumber <= end);
    }
    if (opts.grep) {
      const re = new RegExp(opts.grep, opts.grepFlags ?? 'i');
      const ctx = Math.max(0, opts.context ?? 0);
      if (ctx === 0) {
        out = out.filter((e) => re.test(e.text));
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
    return this.entries.length;
  }

  nextLineNumber(): number {
    return this.firstLineNumber + this.entries.length;
  }

  clear(): void {
    this.firstLineNumber += this.entries.length;
    this.entries = [];
  }
}
