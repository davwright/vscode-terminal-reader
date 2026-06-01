import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import { findBrowser, FoundBrowser } from './ChromeFinder';
import { CdpClient } from './CdpClient';
import { ConsoleBuffer, ConsoleLevel, ConsoleEntry } from './ConsoleBuffer';

// What's IMPLEMENTED in this controller (rest is deferred — see CLAUDE.md):
// - Spawn a headed Chrome/Edge with --remote-debugging-port=<random>
// - Single page target; navigate() reuses the same target
// - Runtime.evaluate (browser_eval)
// - Console.messageAdded + Runtime.consoleAPICalled captured into a buffer
// - DOM via Runtime.evaluate (browser_dom_snapshot, browser_query_selector)
// - Page.captureScreenshot (browser_screenshot)
//
// What's DEFERRED:
// - Multi-tab / target management
// - Network interception, request log, performance traces
// - Iframe-deep evaluation (we always run in the top frame's main world)
// - Persistent user-data-dir (each spawn is fresh)
// - Fancy waiters beyond load / domcontentloaded / brief quiet window

export interface BrowserOpenOptions {
  url?: string;
  file?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface BrowserOpenResult {
  ok: true;
  targetId: string;
  url: string;
  title: string;
  browser: 'chrome' | 'edge';
}

export interface BrowserEvalResult {
  type: string;
  value?: unknown;
  serializedValue?: string;
  exception?: {
    text: string;
    description?: string;
    stack?: string;
  };
}

export class BrowserController {
  private child: ChildProcess | null = null;
  private foundBrowser: FoundBrowser | null = null;
  private userDataDir: string | null = null;
  private cdp: CdpClient | null = null;
  private targetId: string | null = null;
  private currentUrl = '';
  private consoleBuf: ConsoleBuffer;
  // Tracks the last navigation start so waitForLoad doesn't return immediately
  // when called right after navigate().
  private loadFired = false;
  private loadWaiters: (() => void)[] = [];
  private domContentFired = false;
  private domContentWaiters: (() => void)[] = [];
  // Last network activity tick — used by the networkidle approximation.
  private lastNetworkTick = 0;

  constructor(
    private readonly workspaceRoot: string | null,
    consoleBufferLines: () => number
  ) {
    this.consoleBuf = new ConsoleBuffer(consoleBufferLines());
  }

  get isRunning(): boolean {
    return this.child !== null && this.cdp !== null;
  }

  async open(opts: BrowserOpenOptions): Promise<BrowserOpenResult> {
    if (!this.isRunning) await this.spawn();
    return this.navigate(opts);
  }

  async navigate(opts: BrowserOpenOptions): Promise<BrowserOpenResult> {
    if (!this.cdp || !this.targetId) throw new Error('browser not running');
    const url = this.resolveUrl(opts);
    this.loadFired = false;
    this.domContentFired = false;
    await this.cdp.send('Page.navigate', { url });
    const waitUntil = opts.waitUntil ?? 'load';
    if (waitUntil === 'load') {
      await this.waitForLoad(15_000);
    } else if (waitUntil === 'domcontentloaded') {
      await this.waitForDomContent(15_000);
    } else {
      // networkidle approximation: wait for load, then a 500ms quiet window
      // after the last Network.responseReceived event.
      await this.waitForLoad(15_000);
      await this.waitForNetworkQuiet(500, 5_000);
    }
    const titleRes = await this.cdp.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true
    });
    this.currentUrl = url;
    return {
      ok: true,
      targetId: this.targetId,
      url,
      title: String(titleRes?.result?.value ?? ''),
      browser: this.foundBrowser?.name ?? 'chrome'
    };
  }

  async evaluate(expression: string, opts: { returnByValue?: boolean; awaitPromise?: boolean } = {}): Promise<BrowserEvalResult> {
    if (!this.cdp) throw new Error('browser not running');
    const res = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: opts.returnByValue !== false,
      awaitPromise: opts.awaitPromise !== false,
      // userGesture lets click() etc. behave as if the user triggered them.
      userGesture: true
    });
    if (res?.exceptionDetails) {
      const ex = res.exceptionDetails;
      return {
        type: 'exception',
        exception: {
          text: ex.text ?? 'exception',
          description: ex.exception?.description,
          stack: ex.stackTrace?.callFrames?.map((f: any) => `  at ${f.functionName || '<anon>'} (${f.url}:${f.lineNumber}:${f.columnNumber})`).join('\n')
        }
      };
    }
    const r = res.result ?? {};
    if (r.value !== undefined) {
      return { type: r.type, value: r.value };
    }
    return {
      type: r.type,
      serializedValue: r.description ?? r.unserializableValue
    };
  }

  consoleRead(opts: { tail?: number; grep?: string; grepFlags?: string; range?: [number, number]; context?: number }): {
    entries: ConsoleEntry[];
    totalLines: number;
    nextLineNumber: number;
  } {
    return {
      entries: this.consoleBuf.read(opts),
      totalLines: this.consoleBuf.size(),
      nextLineNumber: this.consoleBuf.nextLineNumber()
    };
  }

  consoleClear(): void {
    this.consoleBuf.clear();
  }

  async querySelector(selector: string, all: boolean): Promise<unknown> {
    if (!this.cdp) throw new Error('browser not running');
    const expr = all
      ? `(() => Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => ({
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : undefined,
          text: (el.textContent || '').slice(0, 500),
          attrs: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
          html: el.outerHTML.length > 2000 ? el.outerHTML.slice(0, 2000) + '…' : el.outerHTML
        })))()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; return {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean) : undefined,
          text: (el.textContent || '').slice(0, 500),
          attrs: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
          html: el.outerHTML.length > 2000 ? el.outerHTML.slice(0, 2000) + '…' : el.outerHTML
        }; })()`;
    const res = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return res?.result?.value ?? null;
  }

  async domSnapshot(opts: { rootSelector?: string; maxDepth?: number; includeStyles?: boolean }): Promise<unknown> {
    if (!this.cdp) throw new Error('browser not running');
    const maxDepth = opts.maxDepth ?? 3;
    const root = opts.rootSelector ?? 'html';
    const includeStyles = opts.includeStyles === true;
    const expr = `(() => {
      const root = document.querySelector(${JSON.stringify(root)});
      if (!root) return null;
      const MAX = ${maxDepth};
      const INC_STYLES = ${includeStyles};
      function s(n, d) {
        if (n.nodeType === 3) { const t = (n.nodeValue || '').trim(); return t ? { type: 'text', text: t.slice(0, 200) } : null; }
        if (n.nodeType !== 1) return null;
        const el = n;
        const o = { tag: el.tagName.toLowerCase() };
        if (el.id) o.id = el.id;
        if (el.className && typeof el.className === 'string') {
          const cs = el.className.split(/\\s+/).filter(Boolean);
          if (cs.length) o.classes = cs;
        }
        const attrs = {};
        for (const a of el.attributes) { if (a.name !== 'id' && a.name !== 'class') attrs[a.name] = a.value; }
        if (Object.keys(attrs).length) o.attrs = attrs;
        if (INC_STYLES) {
          const cs = getComputedStyle(el);
          o.styles = { display: cs.display, color: cs.color, backgroundColor: cs.backgroundColor };
        }
        if (d < MAX && el.childNodes.length) {
          const kids = [];
          for (const c of el.childNodes) {
            const cs2 = s(c, d + 1);
            if (cs2) kids.push(cs2);
          }
          if (kids.length) o.children = kids;
        } else if (d >= MAX && el.childNodes.length) {
          o.truncated = el.childNodes.length;
        }
        return o;
      }
      return s(root, 0);
    })()`;
    const res = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return res?.result?.value ?? null;
  }

  async screenshot(opts: { fullPage?: boolean; selector?: string; format?: 'png' | 'jpeg' }): Promise<{
    base64: string;
    format: 'png' | 'jpeg';
    width?: number;
    height?: number;
  }> {
    if (!this.cdp) throw new Error('browser not running');
    const format = opts.format ?? 'png';
    const params: any = { format };
    if (opts.fullPage) {
      params.captureBeyondViewport = true;
      // Page.captureScreenshot will auto-extend when captureBeyondViewport=true
      // and clip is omitted to the full content size.
    }
    if (opts.selector) {
      const box = await this.cdp.send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(opts.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }; })()`,
        returnByValue: true
      });
      const b = box?.result?.value;
      if (!b) throw new Error(`selector not found: ${opts.selector}`);
      params.clip = { ...b, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const res = await this.cdp.send('Page.captureScreenshot', params);
    return {
      base64: res.data,
      format,
      width: params.clip?.width,
      height: params.clip?.height
    };
  }

  async close(): Promise<void> {
    this.dispose();
  }

  dispose(): void {
    if (this.cdp) {
      try {
        this.cdp.close();
      } catch {
        // ignore
      }
      this.cdp = null;
    }
    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.child = null;
    }
    if (this.userDataDir) {
      // Best effort. Chrome may still hold open file handles for a beat.
      try {
        fs.rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore — leaking a few KB in temp is not a real problem
      }
      this.userDataDir = null;
    }
    this.targetId = null;
    this.currentUrl = '';
    this.consoleBuf.clear();
  }

  status(): { running: boolean; browser?: string; url?: string; consoleLines: number } {
    return {
      running: this.isRunning,
      browser: this.foundBrowser?.name,
      url: this.currentUrl || undefined,
      consoleLines: this.consoleBuf.size()
    };
  }

  // ---------- internals ----------

  private resolveUrl(opts: BrowserOpenOptions): string {
    if (opts.url) return opts.url;
    if (opts.file) {
      const abs = path.isAbsolute(opts.file) ? opts.file : path.resolve(this.workspaceRoot ?? process.cwd(), opts.file);
      if (!fs.existsSync(abs)) throw new Error(`file not found: ${abs}`);
      // file:// URL — Chrome wants forward slashes and three leading slashes.
      const norm = abs.replace(/\\/g, '/');
      return norm.startsWith('/') ? `file://${norm}` : `file:///${norm}`;
    }
    throw new Error('open requires { url } or { file }');
  }

  private async spawn(): Promise<void> {
    this.foundBrowser = findBrowser();
    const port = await pickFreePort();
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-terminal-reader-browser-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--remote-debugging-address=127.0.0.1`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--disable-extensions',
      // Open a blank tab; we'll navigate it via Page.navigate.
      'about:blank'
    ];
    this.child = spawn(this.foundBrowser.path, args, {
      detached: false,
      windowsHide: false,
      stdio: 'ignore'
    });
    this.child.on('exit', () => {
      // If Chrome dies, drop our CDP connection.
      if (this.cdp) {
        try {
          this.cdp.close();
        } catch {
          // ignore
        }
        this.cdp = null;
      }
      this.targetId = null;
    });
    const browserWsUrl = await waitForCdpEndpoint(port, 10_000);
    const cdp = new CdpClient();
    await cdp.connect(browserWsUrl);
    this.cdp = cdp;
    // Discover the first page target and attach.
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = (targetInfos as any[]).find((t) => t.type === 'page');
    if (!page) throw new Error('no page target found');
    this.targetId = page.targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    cdp.setSession(sessionId);
    // Enable the domains we use. Page → load events; Runtime → console; Network → idle approximation.
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Console.enable').catch(() => {
      // Deprecated in newer Chromium; Runtime.consoleAPICalled covers it.
    });
    cdp.on('Page.loadEventFired', () => {
      this.loadFired = true;
      const ws = this.loadWaiters.splice(0);
      for (const w of ws) w();
    });
    cdp.on('Page.domContentEventFired', () => {
      this.domContentFired = true;
      const ws = this.domContentWaiters.splice(0);
      for (const w of ws) w();
    });
    cdp.on('Runtime.consoleAPICalled', (p: any) => {
      const level = mapConsoleLevel(p.type);
      const text = (p.args ?? []).map((a: any) => stringifyArg(a)).join(' ');
      const src = p.stackTrace?.callFrames?.[0]
        ? `${p.stackTrace.callFrames[0].url}:${p.stackTrace.callFrames[0].lineNumber}`
        : undefined;
      this.consoleBuf.push(level, text, src);
    });
    cdp.on('Runtime.exceptionThrown', (p: any) => {
      const ex = p.exceptionDetails ?? {};
      const text = ex.exception?.description ?? ex.text ?? 'uncaught exception';
      const src = ex.url ? `${ex.url}:${ex.lineNumber}` : undefined;
      this.consoleBuf.push('error', text, src);
    });
    cdp.on('Network.responseReceived', () => {
      this.lastNetworkTick = Date.now();
    });
    cdp.on('Network.requestWillBeSent', () => {
      this.lastNetworkTick = Date.now();
    });
  }

  private waitForLoad(timeoutMs: number): Promise<void> {
    if (this.loadFired) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.loadWaiters.indexOf(done);
        if (i >= 0) this.loadWaiters.splice(i, 1);
        reject(new Error(`timed out waiting for load (${timeoutMs}ms)`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.loadWaiters.push(done);
    });
  }

  private waitForDomContent(timeoutMs: number): Promise<void> {
    if (this.domContentFired) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.domContentWaiters.indexOf(done);
        if (i >= 0) this.domContentWaiters.splice(i, 1);
        reject(new Error(`timed out waiting for domcontentloaded (${timeoutMs}ms)`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.domContentWaiters.push(done);
    });
  }

  private async waitForNetworkQuiet(quietMs: number, maxWaitMs: number): Promise<void> {
    const start = Date.now();
    while (true) {
      const since = Date.now() - this.lastNetworkTick;
      if (since >= quietMs) return;
      if (Date.now() - start >= maxWaitMs) return;
      await new Promise((r) => setTimeout(r, Math.min(quietMs - since, 200)));
    }
  }
}

function mapConsoleLevel(t: string): ConsoleLevel {
  switch (t) {
    case 'log':
    case 'info':
    case 'warn':
    case 'error':
    case 'debug':
      return t;
    default:
      return 'other';
  }
}

function stringifyArg(a: any): string {
  if (a == null) return String(a);
  if (a.value !== undefined) {
    if (typeof a.value === 'string') return a.value;
    try {
      return JSON.stringify(a.value);
    } catch {
      return String(a.value);
    }
  }
  if (a.description) return a.description;
  if (a.unserializableValue) return a.unserializableValue;
  return a.type ?? '';
}

async function pickFreePort(): Promise<number> {
  // Chrome will refuse to bind a port already in use; ask Node to give us a
  // fresh one and immediately release it. Race window is tiny and the
  // user-data-dir is fresh per spawn so a collision would be visible right
  // away on spawn rather than later.
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      if (a && typeof a === 'object' && 'port' in a) {
        const port = a.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('could not pick free port'));
      }
    });
  });
}

function waitForCdpEndpoint(port: number, timeoutMs: number): Promise<string> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.webSocketDebuggerUrl) {
              resolve(j.webSocketDebuggerUrl);
              return;
            }
          } catch {
            // not ready yet
          }
          retry();
        });
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for Chrome CDP endpoint on port ${port}`));
        return;
      }
      setTimeout(attempt, 100);
    };
    attempt();
  });
}

