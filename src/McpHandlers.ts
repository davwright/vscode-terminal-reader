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
      "Read recent output from a terminal. Use 'name' or 'index'. Optional 'tail' (last N lines) and 'grep' (regex).",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        index: { type: 'number' },
        tail: { type: 'number' },
        grep: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'terminal_read_all',
    description: "Read recent output from every terminal, labelled by name.",
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'number' },
        grep: { type: 'string' }
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
          { tail: args.tail, grep: args.grep, stripAnsi: stripAnsi() }
        );
      case 'terminal_read_all':
        return terminals.readAll({ tail: args.tail, grep: args.grep, stripAnsi: stripAnsi() });
      case 'problems_list':
        return problems.list({ severity: args.severity, pathContains: args.pathContains });
      case 'problems_summary':
        return problems.summary();
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
