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
 * NRQL-looking text. Upper-case keywords alone are enough (`SELECT`/`FROM` followed by whitespace, SHOW EVENT TYPES, or
 * a clause that only NRQL has: FACET, TIMESERIES, SINCE, UNTIL, COMPARE WITH), which also catches fragments without
 * SELECT/FROM. Lower- or mixed-case text needs the pair (`select … from X`, `from X select`), so prose ("from here",
 * "selected") stays out. The typed API (`runNrql` takes only `NrqlQuery`) is the primary control; this rule catches the
 * remaining ways to build NRQL text by hand.
 */
const NRQL_UPPER_RE = /\b(?:SELECT|FROM)\s|\bSHOW\s+EVENT\s+TYPES\b/;
/**
 * NRQL clauses without SELECT/FROM (`SINCE ${x}`, `FACET ${f}`): only a template with an interpolation is a fragment
 * built from input. Interpolating a constant (`${UPPER_SNAKE}`) is fine; prose without interpolation is not checked.
 */
const NRQL_FRAGMENT_RE =
  /\b(?:FACET|TIMESERIES|SINCE|UNTIL|WHERE|LIMIT|COMPARE\s+WITH)\s+\$\{(?!\s*[A-Z][A-Z0-9_]*\s*\})/;
const DYNAMIC_INTERPOLATION_RE = /\$\{(?!\s*[A-Z][A-Z0-9_]*\s*\})/;
// Mixed case needs the pair and a capitalised (or quoted) event type after FROM, which keeps "pick one from the list" out.
const NRQL_PAIR_RE =
  /\b[Ss][Ee][Ll][Ee][Cc][Tt]\s+[\w*`(][\s\S]*?\s[Ff][Rr][Oo][Mm]\s+[A-Z`]|\b[Ff][Rr][Oo][Mm]\s+[A-Z`]\w*`?\s+[Ss][Ee][Ll][Ee][Cc][Tt]\s/;
const nrqlText = (text: string): boolean => NRQL_UPPER_RE.test(text) || NRQL_PAIR_RE.test(text);

/**
 * Entity-search filter text (`name LIKE '…'`, `accountId IN (…)`, `tags.team = …`, `domain = …`): built only with the
 * `entityQuery` tag (nerdgraph/entity-query.ts). Matched on the same literals as NRQL.
 */
const ENTITY_QUERY_RE =
  /\b(?:accountId|domain|type|reporting|alertSeverity|name|tags\.[\w.]+)\s*(?:=|!=|LIKE\b|IN\b)\s*(?:'|\(|\$\{)/;
/** A GraphQL operation (`query Name`, `mutation Name`) with an interpolation: documents are static (T4). */
const GRAPHQL_OPERATION_RE = /^\s*(?:query|mutation)\s+[A-Za-z_]\w*/;
/** Template literals with their tag: `tag`…`` (no nested templates inside `${}`). */
const TEMPLATE_RE = /([\w$.]*)\s*`((?:[^`\\]|\\.)*)`/g;
/** Single- or double-quoted string literals. */
const STRING_RE = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
/**
 * Files allowed to handle NRQL text directly: the tag itself, the tokenizer and the static reference text. `packages/storage/src` and `packages/storage-sqlite/src` hold SQL for
 * the local database (same SELECT/FROM keywords), never NRQL: storage does not talk to NerdGraph (P2-01).
 */
const EXEMPT = [
  /packages\/core\/src\/nrql\/(template|tokenize)\.ts$/,
  // The entity-search tag itself (its own documentation shows filter text).
  /packages\/core\/src\/nerdgraph\/entity-query\.ts$/,
  // Generated: the admin UI's CSS and JS as strings.
  /packages\/admin-ui\/src\/assets\.generated\.ts$/,
  /packages\/storage(-sqlite)?\/src\//,
  // P6-12: the static NRQL cheat sheet shown to agents. Documentation text only, never run or combined with input.
  /packages\/core\/src\/nrql-reference\.ts$/,
];

/**
 * Files that build clause fragments (`SINCE ${n}`, `LIMIT ${n}`) from numbers they computed themselves, never from
 * input text: the limits rewriter (nrql/limits.ts) and the time-range resolver (time/range.ts). They still get the
 * SELECT/FROM checks.
 */
const FRAGMENT_EXEMPT = [/packages\/core\/src\/nrql\/limits\.ts$/, /packages\/core\/src\/time\/range\.ts$/];

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
  const fragmentsOk = FRAGMENT_EXEMPT.some((re) => re.test(file.replaceAll('\\', '/')));
  const out: Violation[] = [];
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length;
  const templates: Array<[number, number]> = [];
  for (const m of code.matchAll(TEMPLATE_RE)) {
    templates.push([m.index, m.index + m[0].length]);
    const tag = m[1] ?? '';
    const text = m[2] ?? '';
    if (tag !== 'nrql' && (nrqlText(text) || (!fragmentsOk && NRQL_FRAGMENT_RE.test(text)))) {
      out.push({
        file,
        line: lineOf(m.index),
        message: 'NRQL template literal must use the `nrql` tag (T4)',
      });
    } else if (tag !== 'entityQuery' && tag !== 'nrql' && ENTITY_QUERY_RE.test(text)) {
      out.push({
        file,
        line: lineOf(m.index),
        message: 'Entity-search filter template literal must use the `entityQuery` tag (T4)',
      });
    }
    if (tag === '' && DYNAMIC_INTERPOLATION_RE.test(text) && GRAPHQL_OPERATION_RE.test(text)) {
      out.push({
        file,
        line: lineOf(m.index),
        message: 'GraphQL document with an interpolation; pass values as GraphQL variables (T4)',
      });
    }
  }
  for (const m of code.matchAll(STRING_RE)) {
    if (templates.some(([a, b]) => m.index >= a && m.index < b)) continue; // quotes inside a template
    const text = m[1] ?? m[2] ?? '';
    if (nrqlText(text)) {
      out.push({
        file,
        line: lineOf(m.index),
        message: 'NRQL in a plain string; build it with the `nrql` tag (T4)',
      });
    } else if (ENTITY_QUERY_RE.test(text)) {
      out.push({
        file,
        line: lineOf(m.index),
        message: 'Entity-search filter in a plain string; build it with the `entityQuery` tag (T4)',
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
