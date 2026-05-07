import * as vscode from 'vscode';

const SEVERITY: Record<number, string> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint'
};

export class ProblemsCapture {
  list(filter: { severity?: string; pathContains?: string } = {}) {
    const all = vscode.languages.getDiagnostics();
    const out: Array<{
      file: string;
      line: number;
      column: number;
      severity: string;
      source?: string;
      code?: string;
      message: string;
    }> = [];
    for (const [uri, diags] of all) {
      const file = uri.fsPath;
      if (filter.pathContains && !file.includes(filter.pathContains)) continue;
      for (const d of diags) {
        const sev = SEVERITY[d.severity] ?? 'unknown';
        if (filter.severity && filter.severity !== sev) continue;
        out.push({
          file,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: sev,
          source: d.source,
          code: typeof d.code === 'object' ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined,
          message: d.message
        });
      }
    }
    return out;
  }

  summary() {
    const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    const byFile = new Map<string, number>();
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) {
        const sev = SEVERITY[d.severity] ?? 'unknown';
        if (sev in counts) (counts as Record<string, number>)[sev]++;
      }
      if (diags.length > 0) byFile.set(uri.fsPath, diags.length);
    }
    const topFiles = Array.from(byFile.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file, count]) => ({ file, count }));
    return { counts, topFiles };
  }
}
