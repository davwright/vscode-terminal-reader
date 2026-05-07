import { TerminalCapture } from './TerminalCapture';
import { ProblemsCapture } from './ProblemsCapture';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'terminal_list',
    description: "List terminals in this VSCode window with their state.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'terminal_read',
    description:
      "Read terminal output. Returns {name, totalLines, lines:[{lineNumber,text},...]} with stable 1-based line numbers (monotonic across reads). Identify the terminal with 'name' or 'index'; default is the most recently active. Selection (combined): 'range:[start,end]' (inclusive) slices by line number; 'grep' (JS regex, case-insensitive default) filters; 'context' adds N before/after lines around each match; 'tail' keeps the last N lines after grep/range.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        index: { type: 'number' },
        tail: { type: 'number' },
        grep: { type: 'string' },
        range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        context: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'terminal_read_all',
    description: "Read every terminal, returns [{name, totalLines, lines:[{lineNumber,text},...]}]. Same options as terminal_read except no name/index targeting.",
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'number' },
        grep: { type: 'string' },
        range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        context: { type: 'number' }
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
            range: args.range,
            context: args.context,
            stripAnsi: stripAnsi()
          }
        );
      case 'terminal_read_all':
        return terminals.readAll({
          tail: args.tail,
          grep: args.grep,
          range: args.range,
          context: args.context,
          stripAnsi: stripAnsi()
        });
      case 'problems_list':
        return problems.list({ severity: args.severity, pathContains: args.pathContains });
      case 'problems_summary':
        return problems.summary();
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
