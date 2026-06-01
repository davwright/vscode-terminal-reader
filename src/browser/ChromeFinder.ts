import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface FoundBrowser {
  path: string;
  // 'chrome' | 'edge' — informational only; both speak CDP identically.
  name: 'chrome' | 'edge';
}

// Known-good install locations on Windows for Chrome + Edge, in preference
// order: per-user installs first (works without admin), then system-wide.
function candidatePaths(): { path: string; name: 'chrome' | 'edge' }[] {
  const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
  const pfx86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const localApp = process.env['LOCALAPPDATA'] ?? path.join(process.env['USERPROFILE'] ?? '', 'AppData', 'Local');
  return [
    { path: path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'chrome' },
    { path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'chrome' },
    { path: path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'chrome' },
    { path: path.join(localApp, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'edge' },
    { path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'edge' },
    { path: path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'edge' }
  ];
}

function whereExe(exe: string): string | null {
  // `where` is the Windows equivalent of `which`. Returns one path per line.
  try {
    const r = spawnSync('where', [exe], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).find((s) => s.trim().length > 0);
      return first ? first.trim() : null;
    }
  } catch {
    // ignore
  }
  return null;
}

export function findBrowser(): FoundBrowser {
  for (const c of candidatePaths()) {
    if (fs.existsSync(c.path)) return c;
  }
  const chrome = whereExe('chrome.exe');
  if (chrome) return { path: chrome, name: 'chrome' };
  const edge = whereExe('msedge.exe');
  if (edge) return { path: edge, name: 'edge' };
  throw new Error(
    'No Chrome or Edge found. Checked these paths:\n' +
      candidatePaths().map((c) => `  - ${c.path}`).join('\n') +
      '\nAlso tried `where chrome.exe` and `where msedge.exe`. Install Google Chrome or Microsoft Edge.'
  );
}
