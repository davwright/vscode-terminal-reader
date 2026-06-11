import { TerminalCapture } from './TerminalCapture';
import { ProblemsCapture } from './ProblemsCapture';
import { Permissions } from './Permissions';
import { HookRunner } from './HookRunner';
import { BrowserController } from './browser/BrowserController';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

const FORMAT_DOC =
  "format: 'text' (default, compact: '   142 | <line>'), 'json' ({lineNumber,text}[] for programmatic), or 'raw' (untouched stream incl. ANSI/OSC 633 — use to detect command boundaries, exit codes, colours). grep/tail/context all work on raw too; bytes within kept lines are unmodified.";

const SELECTION_DOC =
  "Selection options combine: range:[start,end] slices by line number; grep (JS regex, case-insensitive) filters; context:N adds N before/after around each grep match; tail keeps the last N after grep/range.";

// Conservative cap so a single tool call can't monopolise a Claude tool slot
// indefinitely. 5 minutes is enough for most tests/lints/small builds; longer
// jobs should be polled via terminal_state instead.
const WAIT_DEFAULT_MS = 60_000;
const WAIT_MAX_MS = 300_000;
function clampWaitTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : WAIT_DEFAULT_MS;
  return Math.max(0, Math.min(WAIT_MAX_MS, n));
}
// 'finished' on the wire is the caller's shortcut for "the wait resolved on a
// real signal, not a timeout or a setup failure". 'finished' (D-mark) and
// 'pattern' both qualify; 'timeout', 'unsupported', 'invalid-pattern' don't.
function isFinishedReason(r: string): boolean {
  return r === 'finished' || r === 'pattern';
}

export const TOOLS: ToolDef[] = [
  {
    name: 'terminal_list',
    description:
      "List terminals in this VSCode window with state. Each entry: {id, name, cwd, shellIntegration, bufferLines, busy, lastCommand?, lastExitCode?}. busy=true if a command is currently running. `id` is a stable per-terminal handle — pass it back as the `id` target on read/state/interrupt/run/wait to hit exactly this terminal regardless of later renames or index shifts (name can change or collide; index moves as terminals open/close).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'terminal_read',
    description:
      `Read terminal output. Identify with id (stable, preferred), name, or index (default: most recently active). ${SELECTION_DOC} ${FORMAT_DOC} Line numbers are stable, monotonic, 1-based across reads — grep first, then re-read with range:[N-3,N+3] for context.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Stable terminal id from terminal_list. Preferred target — unaffected by renames or index shifts.' },
        name: { type: 'string' },
        index: { type: 'number' },
        tail: { type: 'number' },
        grep: { type: 'string' },
        grepFlags: { type: 'string', description: "JS regex flags. Default 'i' (case-insensitive)." },
        range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        context: { type: 'number' },
        format: { type: 'string', enum: ['text', 'json', 'raw'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'terminal_read_all',
    description: `Read every terminal. ${SELECTION_DOC} ${FORMAT_DOC} Returns one result object per terminal.`,
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'number' },
        grep: { type: 'string' },
        grepFlags: { type: 'string' },
        range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        context: { type: 'number' },
        format: { type: 'string', enum: ['text', 'json', 'raw'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'terminal_state',
    description:
      "Inspect terminal state without reading the buffer. Returns {name, status:'busy'|'idle'|'unknown', shellIntegration, lastCommand, lastExitCode, lastCommandStartedAt, lastCommandFinishedAt, bufferLines, totalLines, cwd}. Use this to poll while a long command runs — totalLines lets you fetch only new output via terminal_read range:[lastSeen+1, totalLines]. status='unknown' means shell integration is off so command boundaries can't be detected.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Stable terminal id from terminal_list. Preferred target — unaffected by renames or index shifts.' },
        name: { type: 'string' },
        index: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'terminal_interrupt',
    description:
      "Send Ctrl-C (ETX) to interrupt a running command. Default target: most recently active terminal. Returns {sent: bool, name?, reason?}. Not gated by any allowlist — interrupting a runaway command is always safe.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Stable terminal id from terminal_list. Preferred target — unaffected by renames or index shifts.' },
        name: { type: 'string' },
        index: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'terminal_clear',
    description:
      "Clear a terminal's captured buffer (does not affect the visible terminal — only the extension's in-memory ring buffer). Pass {all: true} to clear every terminal, or name/index to target one. Default: most recently active. Line numbers continue monotonically — they are NOT reset to 1.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Stable terminal id from terminal_list. Preferred target — unaffected by renames or index shifts.' },
        name: { type: 'string' },
        index: { type: 'number' },
        all: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'terminal_run',
    description:
      "Run a command in a terminal. Gated first by the user's Claude Code PreToolUse hooks " +
      "(from ~/.claude/settings.json — same hooks that run on direct Bash/PowerShell tool calls), " +
      "then by the workspace's .claude/settings.local.json (permissions.allow/deny). " +
      "Default target: most recently active. Defaults to clearing the line-number buffer first so a follow-up terminal_read " +
      "returns only this command's output (the visible terminal is untouched — pass clearFirst:false to keep prior output). " +
      "Returns {accepted, runId?, name?, reason?}. runId is the line number where output will start: use it as both " +
      "terminal_read({range:[runId, totalLines]}) AND terminal_wait({patternStartLine: runId}) for a follow-up wait. " +
      "Compound commands (&&, ||, ;, |) are split and each sub-command must match an allow rule. ask rules and unmatched " +
      "commands are denied (no UI to prompt through MCP). " +
      "PREFER wait:true over launching then polling. With wait:true this one call BLOCKS server-side " +
      "and wakes the instant the command finishes (D-mark from shell integration), a returnOnPattern line appears, " +
      "or waitTimeoutMs elapses — no sleep loops, no repeated terminal_state checks. It costs nothing while it sleeps. " +
      "waitTimeoutMs default 60000, max 300000 (5 min); for a longer job, re-arm with terminal_wait rather than polling. " +
      "When wait:true the response additionally " +
      "carries {finished, reason:'finished'|'pattern'|'timeout'|'unsupported'|'invalid-pattern', exitCode?, matchedLine?, totalLines, elapsedMs}. " +
      "returnOnPattern is a JS regex matched live against each new ANSI-stripped line — use it for early bail-out " +
      "({command:'npm test', wait:true, returnOnPattern:'✗|failed|Error:'} returns the moment a failure appears) AND for " +
      "readiness probes on commands that never exit ({command:'npm run dev', wait:true, returnOnPattern:'Listening on port \\\\d+'}). " +
      "Stderr and stdout cannot be distinguished (the PTY merges them) — the pattern matches the combined stream. " +
      "Only poll terminal_state in a loop when shell integration is OFF (reason:'unsupported').",
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        id: { type: 'number', description: 'Stable terminal id from terminal_list. Preferred target — unaffected by renames or index shifts.' },
        name: { type: 'string' },
        index: { type: 'number' },
        addNewline: { type: 'boolean', description: 'Append newline so the command executes immediately. Default true.' },
        clearFirst: {
          type: 'boolean',
          description:
            'Clear the line-number buffer before sending so the follow-up read sees only this run. Visible terminal is untouched. Default true.'
        },
        wait: {
          type: 'boolean',
          description:
            'Block until the command finishes, a returnOnPattern matches, or waitTimeoutMs elapses. Requires shell integration to detect completion. Default false.'
        },
        waitTimeoutMs: {
          type: 'number',
          description: 'Wait timeout in ms. Default 60000, clamped to [0, 300000]. Ignored unless wait:true.'
        },
        returnOnPattern: {
          type: 'string',
          description:
            "JS regex (NOT a glob); the wait returns as soon as a NEW output line matches. Tested against ANSI-stripped lines, so '^error' works on coloured output. Useful for bail-out on error markers like 'error|Error|ERR!|failed' or readiness probes like 'Listening on port \\\\d+'. Stderr/stdout cannot be distinguished (the PTY merges them), so this matches lines from the combined stream. **Requires wait:true** — silently ignored otherwise."
        },
        returnOnPatternFlags: {
          type: 'string',
          description: "JS regex flags. Default 'i' (case-insensitive)."
        }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  {
    name: 'terminal_wait',
    description:
      "Block until the target terminal becomes idle (shell-integration D-mark), a pattern matches new output, or the timeout elapses. " +
      "Default target: most recently active. Returns {finished, reason:'finished'|'pattern'|'timeout'|'unsupported'|'invalid-pattern', name?, exitCode?, matchedLine?, totalLines, elapsedMs, error?}. " +
      "If the terminal is already idle and no returnOnPattern is set, returns immediately with reason:'finished' and the last exitCode — safe to call as a quick state probe. " +
      "reason:'unsupported' means shell integration is off — no reliable end-of-command signal. " +
      "reason:'invalid-pattern' carries the regex error in `error`. " +
      "returnOnPattern is a JS regex matched against ANSI-stripped lines, so '^error' works on coloured output. Stderr/stdout cannot be distinguished (PTY merges them). " +
      "Use this when a command was launched outside terminal_run (e.g. the user typed it) or when you ran terminal_run without wait:true. " +
      "For a job longer than the 5-min cap, do NOT switch to a sleep loop — re-arm: call this again on reason:'timeout' and it blocks from where it left off. " +
      "Each call is one event-driven sleep, not a busy poll. " +
      "patternStartLine bounds returnOnPattern to lines >= that number — pass the runId returned by terminal_run to ignore pre-existing output. Example: " +
      "terminal_run returns {runId: 1423}; later terminal_wait({patternStartLine: 1423, returnOnPattern: 'Compiled successfully'}) waits for that line only in this run's output.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Stable terminal id from terminal_list. Preferred target — unaffected by renames or index shifts.' },
        name: { type: 'string' },
        index: { type: 'number' },
        timeoutMs: { type: 'number', description: 'Default 60000, clamped to [0, 300000].' },
        returnOnPattern: { type: 'string' },
        returnOnPatternFlags: { type: 'string' },
        patternStartLine: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_open',
    description:
      "Open an embedded browser (Chrome or Edge, spawned by the extension) and navigate to a page. Pass either {url} for an http(s) URL or {file} for a workspace-relative path (resolved to file://). Spawns the browser on first call; subsequent calls reuse it. Returns {ok, targetId, url, title, browser}.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        file: { type: 'string', description: 'Workspace-relative or absolute path.' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_navigate',
    description:
      "Navigate the already-open browser tab to a new URL or file. Same args as browser_open. Use this when the browser is already running and you just want to change the page.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        file: { type: 'string' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_eval',
    description:
      "Evaluate a JavaScript expression in the page's main world (top frame). Returns the JSON-serialized result, or an exception summary if it threw. Defaults: returnByValue=true, awaitPromise=true. Examples: 'window.appState.user.name', 'document.querySelectorAll(\".row\").length', 'await fetch(\"/api/x\").then(r => r.json())'.",
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        returnByValue: { type: 'boolean' },
        awaitPromise: { type: 'boolean' }
      },
      required: ['expression'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_console_read',
    description:
      "Read captured browser console messages (console.log/info/warn/error/debug + uncaught exceptions). Same selection semantics as terminal_read: tail/range/grep/grepFlags/context. Line numbers are stable, monotonic, 1-based across the buffer's lifetime — never reused, including across browser_close.",
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'number' },
        grep: { type: 'string' },
        grepFlags: { type: 'string' },
        range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        context: { type: 'number' },
        format: { type: 'string', enum: ['text', 'json'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_dom_snapshot',
    description:
      "Compact JSON tree of the live DOM. Defaults to depth 3 from <html>. Pass rootSelector to scope to a subtree, maxDepth to go deeper, or includeStyles=true to attach computed display/color/backgroundColor.",
    inputSchema: {
      type: 'object',
      properties: {
        rootSelector: { type: 'string' },
        maxDepth: { type: 'number' },
        includeStyles: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_query_selector',
    description:
      "Query the DOM by CSS selector. By default returns the first match as {tag,id,classes,text,attrs,html}; pass all=true to return an array of every match. Long text/html are truncated.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        all: { type: 'boolean' }
      },
      required: ['selector'],
      additionalProperties: false
    }
  },
  {
    name: 'browser_screenshot',
    description:
      "Capture a screenshot. Default: viewport, PNG. fullPage=true expands to full content height. selector=… clips to that element's bounding box. Returns {base64, format, width?, height?}.",
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean' },
        selector: { type: 'string' },
        format: { type: 'string', enum: ['png', 'jpeg'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'browser_close',
    description: "Close the embedded browser and clear its console buffer. Safe to call when not running.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'browser_status',
    description: "Inspect browser state without driving it: {running, browser?, url?, consoleLines}.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'problems_list',
    description: "List Problems-panel diagnostics. Optional 'severity' (error/warning/info/hint) and 'pathContains'.",
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['error', 'warning', 'info', 'hint'] },
        pathContains: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'problems_summary',
    description: 'Summary counts and top files for Problems-panel diagnostics.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

export function makeDispatcher(opts: {
  terminals: TerminalCapture;
  problems: ProblemsCapture;
  permissions: Permissions;
  hooks: HookRunner;
  stripAnsi: () => boolean;
  browser: BrowserController;
  workspaceRoot: string | null;
}) {
  const { terminals, problems, permissions, hooks, stripAnsi, browser, workspaceRoot } = opts;

  return async function dispatch(method: string, params: any): Promise<any> {
    switch (method) {
      case 'tools/list':
        return { tools: TOOLS };

      case 'tools/call': {
        const name = params?.name as string;
        const args = params?.arguments ?? {};
        const result = await callTool(name, args);
        return {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
        };
      }

      case 'ping':
        return { ok: true, pid: process.pid };

      default:
        throw new Error(`unknown method: ${method}`);
    }
  };

  async function callTool(name: string, args: any): Promise<unknown> {
    switch (name) {
      case 'terminal_list':
        return terminals.list();
      case 'terminal_read':
        return terminals.read(
          { id: args.id, name: args.name, index: args.index },
          {
            tail: args.tail,
            grep: args.grep,
            grepFlags: args.grepFlags,
            range: args.range,
            context: args.context,
            format: args.format,
            stripAnsi: stripAnsi()
          }
        );
      case 'terminal_read_all':
        return terminals.readAll({
          tail: args.tail,
          grep: args.grep,
          grepFlags: args.grepFlags,
          range: args.range,
          context: args.context,
          format: args.format,
          stripAnsi: stripAnsi()
        });
      case 'terminal_state':
        return terminals.state({ id: args.id, name: args.name, index: args.index });
      case 'terminal_interrupt':
        return terminals.interrupt({ id: args.id, name: args.name, index: args.index });
      case 'terminal_clear':
        return terminals.clear({ id: args.id, name: args.name, index: args.index, all: args.all });
      case 'terminal_run': {
        const command = String(args.command ?? '');
        if (!command) return { accepted: false, reason: 'command is required' };
        const target = { id: args.id, name: args.name, index: args.index };
        const shell = terminals.detectShell(target);
        if (!shell) return { accepted: false, reason: 'terminal not found' };
        // Replay the user's Claude Code PreToolUse hooks against this command
        // as if it were a direct Bash/PowerShell tool call. Without this,
        // terminal_run is a side door past hooks that match on "Bash".
        const hookDecision = await hooks.evaluate({
          command,
          shell,
          sessionId: String(process.pid),
          cwd: terminals.cwdOf(target) ?? workspaceRoot ?? ''
        });
        if (hookDecision.decision === 'block') {
          return {
            accepted: false,
            reason: `blocked by PreToolUse hook: ${hookDecision.reason}`,
            hookCommand: hookDecision.hookCommand
          };
        }
        const decision = permissions.evaluate(command, shell);
        if (decision.decision === 'deny') {
          return { accepted: false, reason: decision.reason, rule: decision.rule, source: decision.source };
        }
        if (args.clearFirst !== false) {
          terminals.clear(target);
        }
        const result = terminals.run(target, command, args.addNewline !== false);
        if (!result.sent) return { accepted: false, reason: result.reason };
        const base = { accepted: true, runId: result.runId, name: result.name };
        if (args.wait !== true) return base;
        const waitRes = await terminals.waitForIdle(target, {
          timeoutMs: clampWaitTimeout(args.waitTimeoutMs),
          returnOnPattern: args.returnOnPattern,
          returnOnPatternFlags: args.returnOnPatternFlags,
          patternStartLine: result.runId
        });
        return { ...base, finished: isFinishedReason(waitRes.reason), ...waitRes };
      }
      case 'terminal_wait': {
        const target = { id: args.id, name: args.name, index: args.index };
        const waitRes = await terminals.waitForIdle(target, {
          timeoutMs: clampWaitTimeout(args.timeoutMs),
          returnOnPattern: args.returnOnPattern,
          returnOnPatternFlags: args.returnOnPatternFlags,
          patternStartLine: typeof args.patternStartLine === 'number' ? args.patternStartLine : undefined
        });
        return { finished: isFinishedReason(waitRes.reason), ...waitRes };
      }
      case 'problems_list':
        return problems.list({ severity: args.severity, pathContains: args.pathContains });
      case 'problems_summary':
        return problems.summary();

      case 'browser_open':
        return browser.open({ url: args.url, file: args.file, waitUntil: args.waitUntil });
      case 'browser_navigate':
        return browser.navigate({ url: args.url, file: args.file, waitUntil: args.waitUntil });
      case 'browser_eval':
        return browser.evaluate(String(args.expression ?? ''), {
          returnByValue: args.returnByValue,
          awaitPromise: args.awaitPromise
        });
      case 'browser_console_read': {
        const { entries, totalLines, nextLineNumber } = browser.consoleRead({
          tail: args.tail,
          grep: args.grep,
          grepFlags: args.grepFlags,
          range: args.range,
          context: args.context
        });
        const fmt = args.format === 'json' ? 'json' : 'text';
        if (fmt === 'json') return { entries, totalLines, nextLineNumber };
        const lines = entries.map((e) => `${String(e.lineNumber).padStart(4)} [${e.level}] ${e.text}${e.source ? '  (' + e.source + ')' : ''}`);
        return { totalLines, nextLineNumber, text: lines.join('\n') };
      }
      case 'browser_dom_snapshot':
        return browser.domSnapshot({
          rootSelector: args.rootSelector,
          maxDepth: args.maxDepth,
          includeStyles: args.includeStyles
        });
      case 'browser_query_selector':
        return browser.querySelector(String(args.selector ?? ''), args.all === true);
      case 'browser_screenshot':
        return browser.screenshot({
          fullPage: args.fullPage,
          selector: args.selector,
          format: args.format
        });
      case 'browser_close':
        await browser.close();
        return { ok: true };
      case 'browser_status':
        return browser.status();

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
