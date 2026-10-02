// SPDX-License-Identifier: Apache-2.0
// ADR-0003: every installed dependency must be under a permissive license compatible with Apache-2.0.
// Exceptions need a justification in .license-exceptions.json ({ "pkg-name": "reason" }).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
]);

/** Minimal SPDX expression evaluation: OR = any alternative allowed, AND / WITH = every part allowed. */
export function isAllowed(expression: string, allowed: Set<string> = ALLOWED): boolean {
  const expr = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (expr.length === 0) return false;
  const orParts = splitTopLevel(expr, ' OR ');
  if (orParts.length > 1) return orParts.some((p) => isAllowed(p, allowed));
  const andParts = splitTopLevel(expr, ' AND ');
  if (andParts.length > 1) return andParts.every((p) => isAllowed(p, allowed));
  const [id = ''] = expr.split(' WITH ');
  return allowed.has(id.trim());
}

function splitTopLevel(expr: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && expr.startsWith(sep, i)) {
      parts.push(expr.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts.map((p) => p.trim());
}

interface LicenseEntry {
  name: string;
  versions: string[];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const exceptionsFile = `${root}/.license-exceptions.json`;
  const exceptions: Record<string, string> = existsSync(exceptionsFile)
    ? (JSON.parse(readFileSync(exceptionsFile, 'utf8')) as Record<string, string>)
    : {};
  const out = execFileSync('pnpm', ['licenses', 'list', '--json'], { cwd: root, encoding: 'utf8' });
  const byLicense = JSON.parse(out) as Record<string, LicenseEntry[]>;
  const failures: string[] = [];
  for (const [license, pkgs] of Object.entries(byLicense)) {
    if (isAllowed(license)) continue;
    for (const p of pkgs) {
      if (exceptions[p.name]) continue;
      failures.push(`${p.name}@${p.versions.join(',')}: ${license}`);
    }
  }
  for (const f of failures) console.error(`✗ disallowed license: ${f}`);
  if (failures.length === 0) console.log('✓ all dependency licenses allowed');
  process.exit(failures.length === 0 ? 0 : 1);
}
