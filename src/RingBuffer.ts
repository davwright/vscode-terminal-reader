export class RingBuffer {
  private lines: string[] = [];
  private partial = '';

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
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  flushPartial(): void {
    if (this.partial.length > 0) {
      this.lines.push(this.partial);
      this.partial = '';
      if (this.lines.length > this.maxLines) {
        this.lines.splice(0, this.lines.length - this.maxLines);
      }
    }
  }

  read(opts: { tail?: number; grep?: string; grepFlags?: string } = {}): string[] {
    let out = this.lines;
    if (opts.grep) {
      const re = new RegExp(opts.grep, opts.grepFlags ?? 'i');
      out = out.filter((l) => re.test(l));
    }
    if (opts.tail && opts.tail > 0 && out.length > opts.tail) {
      out = out.slice(out.length - opts.tail);
    }
    return out.slice();
  }

  size(): number {
    return this.lines.length;
  }

  clear(): void {
    this.lines = [];
    this.partial = '';
  }
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
