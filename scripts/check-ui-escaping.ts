// SPDX-License-Identifier: Apache-2.0
// P4-03 (THREAT_MODEL T13): the admin UI renders HTML only through Hono JSX auto-escaping. This guard fails the lint on
// anything that bypasses it (`raw()`, the `html` template helper, `dangerouslySetInnerHTML`) in the UI sources and
// the HTTP app, and on HTML sinks or dynamic code in the UI's script asset (Trusted Types would block them anyway).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const RULES: readonly (readonly [RegExp, string])[] = [
  [/\braw\s*\(/g, '`raw()` renders unescaped HTML'],
  [/\bdangerouslySetInnerHTML\b/g, '`dangerouslySetInnerHTML` renders unescaped HTML'],
  [/['"]hono\/html['"]/g, 'the `hono/html` helpers (`html`, `raw`) bypass JSX escaping'],
  [/\bjsxTemplate\b/g, '`jsxTemplate` bypasses JSX escaping'],
  [/\.(innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(|\bdocument\.write(ln)?\s*\(/g, 'HTML sink'],
  [/\beval\s*\(|\bnew\s+Function\s*\(|\bset(Timeout|Interval)\s*\(\s*['"`]/g, 'dynamic code'],
];

export function checkSource(file: string, source: string): Violation[] {
  const out: Violation[] = [];
  const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
  // Comments may name the forbidden things (to explain the rule); blank them out, keeping line numbers.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
  for (const [re, message] of RULES) {
    for (const m of code.matchAll(re)) out.push({ file, line: lineOf(m.index), message });
  }
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (/\.(ts|tsx|js)$/.test(entry) && !entry.endsWith('.generated.ts')) files.push(p);
  }
  return files;
}

/** The UI sources, its script asset and the HTTP app (which renders the sign-in pages). */
export const CHECKED_DIRS: readonly string[] = [
  'packages/admin-ui/src',
  'packages/admin-ui/assets',
  'packages/http-app/src',
  'packages/core/assets',
  'packages/core/src/apps',
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = CHECKED_DIRS.flatMap((dir) =>
    walk(join(ROOT, dir)).flatMap((f) => checkSource(relative(ROOT, f), readFileSync(f, 'utf8'))),
  );
  for (const v of violations)
    console.error(`✗ ${v.file}:${v.line} ${v.message} (P4-03: use JSX auto-escaping)`);
  process.exit(violations.length === 0 ? 0 : 1);
}
