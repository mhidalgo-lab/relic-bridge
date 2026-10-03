// SPDX-License-Identifier: Apache-2.0
// THREAT_MODEL T4: NRQL in source code is built only with the `nrql` tagged template (packages/core/src/nrql/template.ts),
// which escapes every interpolated value. This check fails on NRQL text in untagged (or differently tagged) template
// literals and in plain strings, however they are later combined (+, +=, join, concat). Defence in depth: runNrql
// only accepts the tag's NrqlQuery type; arbitrary strings go through runRawNrql (run_nrql only).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/**
 * NRQL-looking text: an upper-case SELECT or FROM followed by whitespace, or SHOW EVENT TYPES. Case-sensitive on
 * purpose, to keep prose ("from here", "selected") out. The typed API (`runNrql` takes only `NrqlQuery`) is the
 * primary control; this rule catches the remaining ways to build NRQL text by hand.
 */
const NRQL_TEXT_RE = /\b(?:SELECT|FROM)\s|\bSHOW\s+EVENT\s+TYPES\b/;
/** Template literals with their tag: `tag`…`` (no nested templates inside `${}`). */
const TEMPLATE_RE = /([\w$.]*)\s*`((?:[^`\\]|\\.)*)`/g;
/** Single- or double-quoted string literals. */
const STRING_RE = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
/**
 * Files allowed to handle NRQL text directly: the tag itself and the tokenizer. `packages/storage/src` holds SQL for
 * the local database (same SELECT/FROM keywords), never NRQL: storage does not talk to NerdGraph (P2-01).
 */
const EXEMPT = [/packages\/core\/src\/nrql\/(template|tokenize)\.ts$/, /packages\/storage\/src\//];

export interface Violation {
  file: string;
  line: number;
  message: string;
}

/** Blank out comments (keeping offsets and newlines), so code spans in docs aren't flagged. */
function stripComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/gm, (m, lead: string | undefined) =>
    lead === undefined ? blank(m) : lead + blank(m.slice(lead.length)),
  );
}

export function checkSource(file: string, source: string): Violation[] {
  if (EXEMPT.some((re) => re.test(file.replaceAll('\\', '/')))) return [];
  const code = stripComments(source);
  const out: Violation[] = [];
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length;
  const templates: Array<[number, number]> = [];
  for (const m of code.matchAll(TEMPLATE_RE)) {
    templates.push([m.index, m.index + m[0].length]);
    if ((m[1] ?? '') !== 'nrql' && NRQL_TEXT_RE.test(m[2] ?? '')) {
      out.push({
        file,
        line: lineOf(m.index),
        message: 'NRQL template literal must use the `nrql` tag (T4)',
      });
    }
  }
  for (const m of code.matchAll(STRING_RE)) {
    if (templates.some(([a, b]) => m.index >= a && m.index < b)) continue; // quotes inside a template
    if (NRQL_TEXT_RE.test(m[1] ?? m[2] ?? '')) {
      out.push({
        file,
        line: lineOf(m.index),
        message: 'NRQL in a plain string; build it with the `nrql` tag (T4)',
      });
    }
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

function sourceDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ['packages', 'apps']) {
    for (const name of readdirSync(join(ROOT, group))) {
      const src = join(ROOT, group, name, 'src');
      try {
        if (statSync(src).isDirectory()) dirs.push(src);
      } catch {
        // no src yet
      }
    }
  }
  return dirs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = sourceDirs().flatMap((dir) =>
    walk(dir).flatMap((f) => checkSource(relative(ROOT, f), readFileSync(f, 'utf8'))),
  );
  for (const v of violations) console.error(`✗ ${v.file}:${v.line} ${v.message}`);
  process.exit(violations.length === 0 ? 0 : 1);
}
