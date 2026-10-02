// SPDX-License-Identifier: Apache-2.0
// ADR-0004: packages marked `"relicBridge": { "runtime": "web" }` may only use web-standard APIs.
// Fails on Node built-in imports (`node:*` or bare builtin names) and common Node globals.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));
const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;
const GLOBAL_RE =
  /\b(process\.(?:env|argv|exit|cwd|platform|nextTick)|Buffer\.|__dirname|__filename|require\()/g;

export interface Violation {
  file: string;
  line: number;
  message: string;
}

export function checkSource(file: string, source: string): Violation[] {
  const out: Violation[] = [];
  const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? '';
    const bare = spec.split('/')[0] ?? '';
    if (spec.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(spec)) {
      out.push({
        file,
        line: lineOf(m.index),
        message: `Node built-in import "${spec}" not allowed (ADR-0004)`,
      });
    }
  }
  for (const m of source.matchAll(GLOBAL_RE)) {
    out.push({ file, line: lineOf(m.index), message: `Node global "${m[1]}" not allowed (ADR-0004)` });
  }
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) files.push(p);
  }
  return files;
}

function webPackages(): string[] {
  const dirs: string[] = [];
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(ROOT, group))) {
      const pkgPath = join(ROOT, group, name, 'package.json');
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { relicBridge?: { runtime?: string } };
        if (pkg.relicBridge?.runtime === 'web') dirs.push(join(ROOT, group, name, 'src'));
      } catch {
        // not a package
      }
    }
  }
  return dirs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = webPackages().flatMap((dir) =>
    walk(dir).flatMap((f) => checkSource(relative(ROOT, f), readFileSync(f, 'utf8'))),
  );
  for (const v of violations) console.error(`✗ ${v.file}:${v.line} ${v.message}`);
  process.exit(violations.length === 0 ? 0 : 1);
}
