// SPDX-License-Identifier: Apache-2.0
// Offline tool-description quality checks (P6-13). Deterministic and network-free: they run in `pnpm test`.
// The style guide they enforce is in docs/dev/evals.md.
import { inputJsonSchema, type ToolDefinition } from '../../src/index.ts';
import { UNTRUSTED } from '../../src/tools/shared.ts';

/** Per-tool description ceiling (characters). */
export const MAX_DESCRIPTION_CHARS = 1200;
/** Ceiling of the first paragraph: the purpose, which some clients show alone. */
export const MAX_PURPOSE_CHARS = 450;
/**
 * Ceiling of the whole catalogue as agents see it: every description plus its input JSON Schema (characters, roughly 4
 * per token). 65 683 before P6-13, 61 291 after it, 51 980 after P6-19; raise it only on purpose, every tool list is paid in every conversation.
 */
export const TOOLS_LIST_BUDGET = 52_000;
/** Tools that run this many requests or more must say so ("Runs ..."). */
export const COST_HINT_FROM = 6;
/** Two descriptions this similar (Jaccard of their content words) must be a declared confusable pair. */
export const OVERLAP_THRESHOLD = 0.3;

/**
 * Pairs agents mix up. Each description must name the other tool, so the agent learns when to switch. Keep it in step
 * with docs/dev/evals.md.
 */
export const CONFUSABLE_PAIRS: readonly (readonly [string, string])[] = [
  ['whoami', 'list_accounts'],
  ['run_nrql', 'get_query_result'],
  ['list_event_types', 'get_attributes'],
  ['search_entities', 'resolve_entity'],
  ['get_golden_metrics', 'entity_health'],
  ['entity_health', 'dependency_health'],
  ['get_related_entities', 'dependency_health'],
  ['list_alert_policies', 'list_alert_conditions'],
  ['list_recent_issues', 'search_incidents'],
  ['entity_health', 'generate_alert_insights_report'],
  ['list_error_groups', 'trace_error'],
  ['list_change_events', 'analyze_deployment_impact'],
  ['analyze_transactions', 'analyze_deployment_impact'],
  ['list_top_transactions', 'analyze_transactions'],
  ['list_recent_logs', 'analyze_entity_logs'],
  ['list_recent_logs', 'trace_error'],
  ['analyze_threads', 'list_gc_metrics'],
  ['list_dashboards', 'get_dashboard'],
];

/** Verbs our tool names start with: a snake_case word with one of these prefixes in a description must be a tool. */
const TOOL_VERB_RE = /\b(?:list|get|search|analyze|generate|run|resolve|decode|trace)_[a-z_]+\b/g;
/** The `name` input added by withEntityName / entityRefFields (P6-17, P6-18). */
const ENTITY_NAME_FIELD_RE = /^Entity name instead of guid/;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly openWorld: boolean;
  readonly cost: number;
  readonly inputSchema: Record<string, unknown>;
}

export function listed(tools: readonly ToolDefinition[]): ListedTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    openWorld: t.openWorld,
    cost: t.cost,
    inputSchema: inputJsonSchema(t) as Record<string, unknown>,
  }));
}

function properties(t: ListedTool): Record<string, { description?: unknown }> {
  return (t.inputSchema['properties'] ?? {}) as Record<string, { description?: unknown }>;
}

/** Whether the tool takes an entity by name (P6-17/18). */
export function takesEntityName(t: ListedTool): boolean {
  const d = properties(t)['name']?.description;
  return typeof d === 'string' && ENTITY_NAME_FIELD_RE.test(d);
}

/** Characters a `tools/list` of these tools spends on descriptions and input schemas. */
export function catalogueSize(tools: readonly ListedTool[]): number {
  return tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.inputSchema).length, 0);
}

/** Every rule of the style guide; returns human-readable problems (empty = clean). */
export function lintDescriptions(tools: readonly ListedTool[]): string[] {
  const problems: string[] = [];
  const names = new Set(tools.map((t) => t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const t of tools) {
    const d = t.description;
    const say = (msg: string) => problems.push(`${t.name}: ${msg}`);
    if (d.length > MAX_DESCRIPTION_CHARS)
      say(`description is ${d.length} chars (max ${MAX_DESCRIPTION_CHARS})`);
    const purpose = d.split(/\n\s*\n/)[0] ?? '';
    if (purpose.length > MAX_PURPOSE_CHARS)
      say(`first paragraph is ${purpose.length} chars (max ${MAX_PURPOSE_CHARS})`);
    if (!/\n\s*\n/.test(d)) say('no second paragraph (when to use it, alternatives)');
    if (/^(?:this tool|use |tool |allows )/i.test(d)) say('does not open with what it returns');
    for (const m of d.matchAll(TOOL_VERB_RE)) {
      if (!names.has(m[0]) && !(m[0] in properties(t))) say(`mentions unknown tool "${m[0]}"`);
    }
    for (const [field, schema] of Object.entries(properties(t))) {
      if (typeof schema.description !== 'string' || schema.description.trim().length < 3)
        say(`input "${field}" has no description`);
    }
    if (t.openWorld && !d.includes(UNTRUSTED)) say('open-world tool without the untrusted-data sentence');
    if (t.cost >= COST_HINT_FROM && !/\bRuns\b/.test(d)) say(`cost ${t.cost} but no "Runs ..." hint`);
    if (/guid from search_entities/.test(d))
      say('says "guid from search_entities"; say "(guid or name)" instead');
    if (takesEntityName(t) && !/\bor name\b/.test(d))
      say('takes an entity name but the description does not say "or name"');
  }
  for (const [a, b] of CONFUSABLE_PAIRS) {
    const ta = byName.get(a);
    const tb = byName.get(b);
    if (!ta || !tb) {
      problems.push(`confusable pair ${a}/${b}: unknown tool`);
      continue;
    }
    if (!ta.description.includes(b)) problems.push(`${a}: does not mention its confusable sibling ${b}`);
    if (!tb.description.includes(a)) problems.push(`${b}: does not mention its confusable sibling ${a}`);
  }
  const declared = new Set(CONFUSABLE_PAIRS.map(([a, b]) => [a, b].sort().join(' ')));
  for (const { a, b, score } of overlaps(tools)) {
    if (score >= OVERLAP_THRESHOLD && !declared.has([a, b].sort().join(' ')))
      problems.push(
        `${a} and ${b} read alike (${score.toFixed(2)}): declare them in CONFUSABLE_PAIRS and cross-reference`,
      );
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text helpers: tokens, overlap, a BM25 router.

const STOP = new Set(
  (
    'a an and are as at be by can do does for from has have how i in into is it its me my of on one or our so that the ' +
    "their them then there these this to us was we what when where which who why will with you your use it's any all " +
    'up down new relic default call tool tools result text untrusted data never follow instructions'
  ).split(' '),
);

/** Lowercase content words with a light plural/verb-ending fold, so "errors" meets "error". */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(?:ies)$/, 'y').replace(/(?:ing|ed|es|s)$/, (s, i: number) => (i >= 3 ? '' : s)));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** Pairwise similarity of the descriptions, most similar first. */
export function overlaps(tools: readonly ListedTool[]): { a: string; b: string; score: number }[] {
  const sets = tools.map((t) => ({ name: t.name, words: new Set(tokens(t.description)) }));
  const out: { a: string; b: string; score: number }[] = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const x = sets[i] as (typeof sets)[number];
      const y = sets[j] as (typeof sets)[number];
      out.push({ a: x.name, b: y.name, score: jaccard(x.words, y.words) });
    }
  }
  return out.sort((p, q) => q.score - p.score);
}

/**
 * A deterministic stand-in for the model: BM25 over each tool's name (weighted) and description. It does not
 * understand anything; it measures how much each description's words point at the questions it should answer. A drop
 * means a rewrite made tools harder to tell apart.
 */
export function createRouter(tools: readonly ListedTool[]): (question: string) => string[] {
  const k1 = 1.2;
  const b = 0.75;
  const docs = tools.map((t) => {
    const nameWords = tokens(t.name.replaceAll('_', ' '));
    const words = [...nameWords, ...nameWords, ...nameWords, ...tokens(t.description)];
    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { name: t.name, tf, len: words.length };
  });
  const avg = docs.reduce((n, d) => n + d.len, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => {
    const n = df.get(w) ?? 0;
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
  };
  return (question) => {
    const q = [...new Set(tokens(question))];
    return docs
      .map((d) => {
        let score = 0;
        for (const w of q) {
          const f = d.tf.get(w) ?? 0;
          if (f > 0) score += idf(w) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)));
        }
        return { name: d.name, score };
      })
      .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name))
      .map((r) => r.name);
  };
}

export interface RouterScore {
  readonly cases: number;
  /** Cases whose top-ranked tool is an acceptable one. */
  readonly top1: number;
  /** Cases with an acceptable tool among the top three. */
  readonly top3: number;
  readonly misses: readonly { id: string; expected: readonly string[]; got: readonly string[] }[];
}

export function scoreRouter(
  tools: readonly ListedTool[],
  cases: readonly { id: string; question: string; expect: readonly string[] }[],
): RouterScore {
  const route = createRouter(tools);
  let top1 = 0;
  let top3 = 0;
  const misses: { id: string; expected: readonly string[]; got: readonly string[] }[] = [];
  for (const c of cases) {
    const ranked = route(c.question).slice(0, 3);
    if (c.expect.includes(ranked[0] ?? '')) top1++;
    if (ranked.some((n) => c.expect.includes(n))) top3++;
    else misses.push({ id: c.id, expected: c.expect, got: ranked });
  }
  return { cases: cases.length, top1, top3, misses };
}
