import { TerminalCapture } from './TerminalCapture';
import { ProblemsCapture } from './ProblemsCapture';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

const FORMAT_DOC =
  "format: 'text' (default, compact: '   142 | <line>'), 'json' ({lineNumber,text}[] for programmatic), or 'raw' (untouched stream incl. ANSI/OSC 633 — use to detect command boundaries, exit codes, colours).";

const SELECTION_DOC =
  "Selection options combine: range:[start,end] slices by line number; grep (JS regex, case-insensitive) filters; context:N adds N before/after around each grep match; tail keeps the last N after grep/range.";

export const TOOLS: ToolDef[] = [
  {
    name: 'terminal_list',
    description:
      "List terminals in this VSCode window with state. Each entry: {name, cwd, shellIntegration, bufferLines, busy, lastCommand?, lastExitCode?}. busy=true if a command is currently running.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'terminal_read',
    description:
      `Read terminal output. Identify with name or index (default: most recently active). ${SELECTION_DOC} ${FORMAT_DOC} Line numbers are stable, monotonic, 1-based across reads — grep first, then re-read with range:[N-3,N+3] for context.`,
    inputSchema: {
      type: 'object',
      properties: {
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
        name: { type: 'string' },
        index: { type: 'number' },
        all: { type: 'boolean' }
      },
      additionalProperties: false
    }
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
  stripAnsi: () => boolean;
}) {
  const { terminals, problems, stripAnsi } = opts;

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
          { name: args.name, index: args.index },
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
        return terminals.state({ name: args.name, index: args.index });
      case 'terminal_interrupt':
        return terminals.interrupt({ name: args.name, index: args.index });
      case 'terminal_clear':
        return terminals.clear({ name: args.name, index: args.index, all: args.all });
      case 'problems_list':
        return problems.list({ severity: args.severity, pathContains: args.pathContains });
      case 'problems_summary':
        return problems.summary();
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
