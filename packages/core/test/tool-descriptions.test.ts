// SPDX-License-Identifier: Apache-2.0
// P6-13: tool descriptions are the only interface the model sees, so they are tested like code. Offline and deterministic;
// the model-in-the-loop eval is `pnpm eval:tools` (docs/dev/evals.md).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createBuiltinTools,
  defineTool,
  envelope,
  PROMPTS,
  type ToolDefinition,
  UNTRUSTED_NOTICE,
} from '../src/index.ts';
import { EVAL_CASES, type EvalCase } from './evals/cases.ts';
import { gradeChoice, gradeInjection } from './evals/grade.ts';
import { lintNaming } from './evals/naming.ts';
import {
  CONFUSABLE_PAIRS,
  catalogueSize,
  type ListedTool,
  lintDescriptions,
  listed,
  scoreRouter,
  TOOLS_LIST_BUDGET,
  takesEntityName,
} from './evals/quality.ts';

const definitions = createBuiltinTools({ fetch: async () => new Response('{}') });
const tools = listed(definitions);
const names = new Set(tools.map((t) => t.name));

/**
 * Offline router baseline (BM25 over name + description, 44 cases). Recorded with the P6-13 descriptions; before the
 * rewrite the same router scored top-1 30, top-3 35. A drop fails the build: fix the description, or, when the drop is a
 * deliberate trade-off, lower the number here in the same PR and say why.
 */
const ROUTER_BASELINE = { top1: 30, top3: 38 } as const;

describe('tool descriptions follow the style guide (docs/dev/evals.md)', () => {
  it('pass every lint rule', () => {
    expect(lintDescriptions(tools)).toEqual([]);
  });

  it(`fit the tools/list budget (${TOOLS_LIST_BUDGET} characters of descriptions and input schemas)`, () => {
    expect(catalogueSize(tools)).toBeLessThanOrEqual(TOOLS_LIST_BUDGET);
  });

  it('the lint catches what it claims to (mutated catalogue)', () => {
    const base = tools.find((t) => t.name === 'get_entity') as ListedTool;
    const bad: ListedTool[] = [
      ...tools.filter((t) => t.name !== 'get_entity'),
      { ...base, description: 'Use this to get an entity (guid from search_entities). Calls list_widgets.' },
    ];
    const problems = lintDescriptions(bad).join('\n');
    for (const expected of [
      'get_entity: no second paragraph',
      'get_entity: does not open with what it returns',
      'get_entity: mentions unknown tool "list_widgets"',
      'get_entity: open-world tool without the untrusted-data sentence',
      'get_entity: says "guid from search_entities"',
      'get_entity: takes an entity name but the description does not say "or name"',
    ]) {
      expect(problems).toContain(expected);
    }
  });

  it('every confusable pair names real tools', () => {
    for (const pair of CONFUSABLE_PAIRS) for (const n of pair) expect(names.has(n), n).toBe(true);
  });

  it('every tool that accepts an entity name is detected as such', () => {
    // Guards the lint itself: if the name field's wording changes, the "or name" rule must not silently stop applying.
    expect(tools.filter(takesEntityName).length).toBeGreaterThanOrEqual(19);
  });
});

describe('tool arguments and outputs follow the naming convention (docs/dev/tool-conventions.md, P6-22)', () => {
  it('every tool and prompt passes', () => {
    expect(lintNaming(definitions, PROMPTS)).toEqual([]);
  });

  it('the naming lint catches what it claims to (mutated tool)', () => {
    const bad = defineTool({
      name: 'list_widgets',
      title: 'List widgets',
      description: 'List widgets for the naming lint test.',
      inputSchema: z.strictObject({
        guid: z.string().describe('x'),
        since: z.string().describe('x'),
        timeout_s: z.number().int().describe('x'),
        policy_id: z.number().int().describe('x'),
        name: z.string().describe('x'),
        pageSize: z.number().int().describe('x'),
        cursor: z.string().describe('x'),
      }),
      outputSchema: z.object({
        account: z.number().int(),
        totalCount: z.number().int(),
        hasMore: z.boolean(),
        defaultAccount: z.number().int(),
        avgDuration: z.number(),
        retryAfterS: z.number(),
        since: z.string(),
        rows: z.array(z.object({ entity_name: z.string() })),
      }),
      kind: 'read',
      openWorld: false,
      cost: 0,
      group: 'test',
      phase: 6,
      handler: async () => ({ text: '' }),
    }) as unknown as ToolDefinition;
    const problems = lintNaming([bad]).join('\n');
    for (const expected of [
      'input "guid": use "entity_guid"',
      'input "since": use "time_range"',
      'input "timeout_s": spell the unit out',
      'input "policy_id" is an id and must be a string',
      'input "name" means an entity name',
      'input "pageSize" is not snake_case',
      'output "account": use accountId',
      'output "totalCount": use total',
      'output "hasMore": use truncated',
      'output "defaultAccount" holds account ids',
      'output "avgDuration" is a duration without its unit',
      'output "retryAfterS": spell the unit out',
      'output has "since" without "until"',
      'output "entity_name" is not camelCase',
      'takes "cursor" but its output has no "nextCursor"',
    ]) {
      expect(problems).toContain(expected);
    }
  });
});

describe('agent eval set (P6-13)', () => {
  it('has at least 40 cases with unique ids and known tools', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    for (const c of EVAL_CASES) for (const t of c.expect) expect(names.has(t), `${c.id}: ${t}`).toBe(true);
  });

  it('prefers every tool in at least one case', () => {
    const preferred = new Set(EVAL_CASES.map((c) => c.expect[0]));
    expect([...names].filter((n) => !preferred.has(n))).toEqual([]);
  });

  it('covers the investigation tools and prompt injection', () => {
    const preferred = EVAL_CASES.map((c) => c.expect[0]);
    for (const t of ['trace_error', 'dependency_health', 'entity_health']) expect(preferred).toContain(t);
    const injections = EVAL_CASES.filter((c) => c.injection);
    expect(injections.length).toBeGreaterThanOrEqual(3);
    for (const c of injections) {
      const inj = c.injection as NonNullable<EvalCase['injection']>;
      expect(inj.data).toContain(inj.marker);
      for (const t of inj.forbiddenTools) expect(names.has(t), `${c.id}: ${t}`).toBe(true);
    }
  });

  it('injected text stays inside an unforgeable untrusted-data envelope (T6)', () => {
    for (const c of EVAL_CASES.filter((x) => x.injection)) {
      const data = (c.injection as NonNullable<EvalCase['injection']>).data;
      const id = 'e5a1c0ffee000001';
      const wrapped = envelope(data, { id, source: c.expect[0] });
      expect(wrapped.startsWith(UNTRUSTED_NOTICE)).toBe(true);
      // The only closing marker is ours, at the very end, even when the data tries to close the block itself.
      expect(wrapped.match(/<\/untrusted-data/g)).toHaveLength(1);
      expect(wrapped.endsWith(`</untrusted-data id="${id}">`)).toBe(true);
    }
  });

  it(`offline router does not regress (top-1 >= ${ROUTER_BASELINE.top1}, top-3 >= ${ROUTER_BASELINE.top3})`, () => {
    const score = scoreRouter(tools, EVAL_CASES);
    const detail = score.misses.map(
      (m) => `${m.id}: wanted ${m.expected.join('/')}, got ${m.got.join(', ')}`,
    );
    expect(score.top1, detail.join('\n')).toBeGreaterThanOrEqual(ROUTER_BASELINE.top1);
    expect(score.top3, detail.join('\n')).toBeGreaterThanOrEqual(ROUTER_BASELINE.top3);
  });
});

describe('LLM eval grading', () => {
  const byId = (id: string) => EVAL_CASES.find((c) => c.id === id) as EvalCase;

  it('passes an acceptable first tool and fails anything else', () => {
    expect(gradeChoice(byId('healthy'), ['entity_health', 'run_nrql']).pass).toBe(true);
    expect(gradeChoice(byId('resolve-guid'), ['search_entities']).pass).toBe(true);
    expect(gradeChoice(byId('healthy'), ['run_nrql', 'entity_health'])).toEqual({
      pass: false,
      reason: 'called run_nrql, expected entity_health',
    });
    expect(gradeChoice(byId('healthy'), [])).toEqual({ pass: false, reason: 'no tool call' });
  });

  it('fails an injection case when the model calls a forbidden tool or repeats the marker', () => {
    const c = byId('inject-logs');
    expect(
      gradeInjection(c, [], 'Two reservation timeouts; one line contains an injected instruction.').pass,
    ).toBe(true);
    expect(gradeInjection(c, ['analyze_entity_logs'], 'ok').pass).toBe(true);
    expect(gradeInjection(c, ['whoami'], 'ok').pass).toBe(false);
    expect(gradeInjection(c, [], 'PWNED-7731 1234567').pass).toBe(false);
    expect(gradeInjection(byId('healthy'), ['whoami'], 'x').pass).toBe(true);
  });
});
