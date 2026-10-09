// SPDX-License-Identifier: Apache-2.0
// Tool argument and output naming convention (P6-22). Offline and deterministic: runs in `pnpm test` through
// tool-descriptions.test.ts. The convention itself is written down in docs/dev/tool-conventions.md; keep them in step.
import {
  inputJsonSchema,
  outputJsonSchema,
  type PromptDefinition,
  promptArgsJsonSchema,
  type ToolDefinition,
} from '../../src/index.ts';

type Json = Record<string, unknown>;

const SNAKE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const CAMEL_RE = /^[a-z][a-zA-Z0-9]*$/;

/** Input names that mean something we already have a name for. Key: the wrong name; value: the right one. */
export const INPUT_SYNONYMS: Readonly<Record<string, string>> = {
  guid: 'entity_guid',
  entity_id: 'entity_guid',
  entityguid: 'entity_guid',
  since: 'time_range',
  until: 'time_range',
  window: 'time_range',
  from: 'time_range',
  start_time: 'time_range',
  end_time: 'time_range',
  account_id: 'account',
  accountid: 'account',
  account_ids: 'accounts',
  next_cursor: 'cursor',
  page: 'cursor',
  page_token: 'cursor',
  max_results: 'limit',
  page_size: 'limit',
  size: 'limit',
  count: 'limit',
  top: 'limit',
  minimal: 'minimal_output',
  compact: 'minimal_output',
  brief: 'minimal_output',
  compare: 'compare_previous',
  name_like: 'name_contains',
  search: 'contains',
  text: 'contains',
  filter: 'contains',
  q: 'contains',
};

/** Output names that mean something we already have a name for. */
export const OUTPUT_SYNONYMS: Readonly<Record<string, string>> = {
  account: 'accountId',
  accounts: 'accountIds (a list of ids) or a list of account objects',
  defaultAccount: 'defaultAccountId',
  totalCount: 'total',
  hasMore: 'truncated (or nextCursor when the tool pages)',
  maybeMore: 'truncated (or nextCursor when the tool pages)',
  moreAvailable: 'truncated (or nextCursor when the tool pages)',
  more: 'truncated (or nextCursor when the tool pages)',
  cursor: 'nextCursor',
  next: 'nextCursor',
};

/** An integer duration input says its unit in full (`timeout_seconds`, `compare_minutes`, `lookback_days`). */
const SHORT_UNIT_INPUT_RE = /_(?:s|sec|secs|ms|millis|min|mins|h|hr|hrs|d)$/;
const INPUT_UNIT_RE = /_(?:seconds|minutes|hours|days)$/;
/** An output duration says its unit: `durationMs`, `avgDurationSeconds`, `periodMinutes`, `retryAfterSeconds`. */
const OUTPUT_UNIT_RE = /(?:Ms|Seconds|Minutes|Hours|Days)$/;
const SHORT_UNIT_OUTPUT_RE = /[a-z](?:S|Sec|Secs|Min|Mins|Hrs)$/;

/** The JSON types a schema node allows (`anyOf` / `type` arrays flattened; `const` and `enum` read as their values). */
export function typesOf(node: unknown): Set<string> {
  const out = new Set<string>();
  if (node === null || typeof node !== 'object') return out;
  const s = node as Json;
  const t = s['type'];
  if (typeof t === 'string') out.add(t);
  if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
  for (const key of ['anyOf', 'oneOf']) {
    const alts = s[key];
    if (Array.isArray(alts)) for (const a of alts) for (const x of typesOf(a)) out.add(x);
  }
  if (Array.isArray(s['enum']))
    for (const v of s['enum'] as unknown[]) out.add(v === null ? 'null' : typeof v);
  return out;
}

const props = (schema: unknown): Record<string, Json> =>
  ((schema as Json | undefined)?.['properties'] ?? {}) as Record<string, Json>;

/** The object schemas below a node: itself, array items and `anyOf` branches (one level of each, recursively). */
function objectsUnder(node: unknown, depth = 0): Json[] {
  if (depth > 12 || node === null || typeof node !== 'object') return [];
  const s = node as Json;
  const found: Json[] = [];
  if (s['properties'] && typeof s['properties'] === 'object') found.push(s);
  for (const p of Object.values(props(s))) found.push(...objectsUnder(p, depth + 1));
  if (s['items']) found.push(...objectsUnder(s['items'], depth + 1));
  for (const key of ['anyOf', 'oneOf']) {
    const alts = s[key];
    if (Array.isArray(alts)) for (const a of alts) found.push(...objectsUnder(a, depth + 1));
  }
  return found;
}

const only = (types: Set<string>, allowed: readonly string[]) =>
  types.size > 0 && [...types].every((t) => allowed.includes(t));

/** Problems with one set of input arguments (a tool's input schema or a prompt's arguments). */
function lintInputs(owner: string, schema: Json, isPrompt: boolean): string[] {
  const problems: string[] = [];
  const say = (msg: string) => problems.push(`${owner}: ${msg}`);
  const fields = props(schema);
  for (const [name, node] of Object.entries(fields)) {
    const types = typesOf(node);
    if (!SNAKE_RE.test(name)) say(`input "${name}" is not snake_case`);
    const synonym = INPUT_SYNONYMS[name];
    if (synonym) say(`input "${name}": use "${synonym}"`);
    if (SHORT_UNIT_INPUT_RE.test(name))
      say(`input "${name}": spell the unit out (_seconds, _minutes, _hours, _days)`);
    if (INPUT_UNIT_RE.test(name) && !isPrompt && !only(types, ['integer', 'number']))
      say(`input "${name}" names a unit but is not a number`);
    // Prompt arguments are strings by MCP definition; the type rules apply to tools only.
    if (isPrompt) continue;
    if (name.endsWith('_id') && !only(types, ['string']))
      say(`input "${name}" is an id and must be a string`);
    if (name.endsWith('_contains') && !only(types, ['string']))
      say(`input "${name}" is a text filter and must be a string`);
    const expected: Record<string, readonly string[]> = {
      account: ['integer'],
      accounts: ['array'],
      entity_guid: ['string'],
      name: ['string'],
      time_range: ['string'],
      lookback: ['string'],
      limit: ['integer'],
      cursor: ['string'],
      minimal_output: ['boolean'],
      contains: ['string'],
    };
    const want = expected[name];
    if (want && !only(types, want)) say(`input "${name}" must be ${want.join(' or ')}`);
  }
  if (!isPrompt && 'name' in fields && !('entity_guid' in fields))
    say(
      'input "name" means an entity name resolved to entity_guid; for a substring filter use "name_contains"',
    );
  return problems;
}

/** Problems with a tool's structured output schema (every nested object, recursively). */
function lintOutputs(owner: string, schema: Json): string[] {
  const problems: string[] = [];
  const say = (msg: string) => problems.push(`${owner}: ${msg}`);
  for (const obj of objectsUnder(schema)) {
    const fields = props(obj);
    for (const [name, node] of Object.entries(fields)) {
      const types = typesOf(node);
      if (!CAMEL_RE.test(name)) say(`output "${name}" is not camelCase`);
      const synonym = OUTPUT_SYNONYMS[name];
      const idsList = name === 'accounts' && typesOf((node as Json)['items']).has('object');
      if (synonym && !idsList) say(`output "${name}": use ${synonym}`);
      // Any key holding an account id (or ids) ends with AccountId(s), e.g. `accountId`, `dataAccountId`.
      const intLike =
        only(types, ['integer', 'number', 'null']) ||
        (types.has('array') && only(typesOf((node as Json)['items']), ['integer', 'number']));
      if (/[aA]ccounts?$/.test(name) && intLike)
        say(`output "${name}" holds account ids: name it ...AccountId(s)`);
      if (/duration/i.test(name) && !OUTPUT_UNIT_RE.test(name))
        say(`output "${name}" is a duration without its unit (Ms, Seconds, Minutes...)`);
      if (SHORT_UNIT_OUTPUT_RE.test(name)) say(`output "${name}": spell the unit out (Seconds, Minutes...)`);
      const expected: Record<string, readonly string[]> = {
        nextCursor: ['string', 'null'],
        truncated: ['boolean'],
        partial: ['boolean'],
        hiddenOutsideScope: ['boolean'],
        total: ['integer', 'number', 'null'],
        since: ['string', 'null'],
        until: ['string', 'null'],
        accountId: ['integer', 'null'],
        entityGuid: ['string', 'null'],
      };
      const want = expected[name];
      if (want && !only(types, want)) say(`output "${name}" must be ${want.join(' | ')}`);
    }
    if ('since' in fields !== 'until' in fields) say('output has "since" without "until" (or the reverse)');
  }
  return problems;
}

/** Every naming rule of docs/dev/tool-conventions.md; returns human-readable problems (empty = clean). */
export function lintNaming(
  tools: readonly Pick<ToolDefinition, 'name' | 'inputSchema' | 'outputSchema'>[],
  prompts: readonly Pick<PromptDefinition, 'name' | 'argsSchema'>[] = [],
): string[] {
  const problems: string[] = [];
  for (const t of tools) {
    const input = inputJsonSchema(t);
    problems.push(...lintInputs(t.name, input, false));
    const output = outputJsonSchema(t) as Json | undefined;
    if (output) {
      problems.push(...lintOutputs(t.name, output));
      if ('cursor' in props(input) && !('nextCursor' in props(output)))
        problems.push(`${t.name}: takes "cursor" but its output has no "nextCursor"`);
      if ('nextCursor' in props(output) && !('cursor' in props(input)))
        problems.push(`${t.name}: returns "nextCursor" but takes no "cursor"`);
    }
  }
  for (const p of prompts) problems.push(...lintInputs(`prompt ${p.name}`, promptArgsJsonSchema(p), true));
  return problems;
}
