// SPDX-License-Identifier: Apache-2.0
// MCP Tasks for the remaining composite reports (P7-23): generate_user_impact_report, entity_health, dependency_health.
import { describe, expect, it } from 'vitest';
import {
  createBudget,
  createInvestigationTools,
  createReportTools,
  createTask,
  ErrorCode,
  type FetchLike,
  getTask,
  type TaskJob,
  type ToolContext,
  type ToolDefinition,
} from '../src/index.ts';
import { testContext } from './helpers/context.ts';
import { MOCK_ACCOUNT, MOCK_GUID, mockNerdGraph } from './helpers/mock-nerdgraph.ts';
import { json } from './helpers/nerdgraph.ts';

const A = MOCK_ACCOUNT;
const B = 1000004;
const OTHER = 1000007;
const NOW = 1790943448000;
const MIN = 60_000;
const guidOf = (account: number, domain: string, type: string, id: string) =>
  btoa(`${account}|${domain}|${type}|${id}`).replace(/=+$/, '');
const BROWSER = guidOf(A, 'BROWSER', 'APPLICATION', '7');
const MOBILE = guidOf(B, 'MOBILE', 'APPLICATION', '8');
const MONITOR = guidOf(A, 'SYNTH', 'MONITOR', '9');
const API = guidOf(A, 'APM', 'APPLICATION', '2');
const DB = guidOf(A, 'INFRA', 'HOST', '1');
const FOREIGN = guidOf(OTHER, 'APM', 'APPLICATION', '4');

const vertex = (guid: string, account: number, name: string, severity: string | null = null) => ({
  guid,
  accountId: account,
  entity: {
    guid,
    name,
    accountId: account,
    domain: 'X',
    type: 'Y',
    alertSeverity: severity,
    reporting: true,
  },
});
const edge = (a: ReturnType<typeof vertex>) => ({
  type: 'CALLS',
  source: a,
  target: vertex(MOCK_GUID, A, 'checkout'),
});

const nrqlBody = (rows: Record<string, unknown>[]) =>
  json({
    data: {
      actor: {
        account: {
          nrql: {
            results: rows,
            metadata: { eventTypes: ['PageView'], facets: ['entityGuid'], messages: null, timeWindow: null },
            totalResult: null,
            otherResult: null,
            queryProgress: { queryId: null, completed: true, retryAfter: null, resultExpiration: null },
          },
        },
      },
    },
  });

const curSince = Math.floor((NOW - 60 * MIN) / 1000);
const answers = (text: string): Response | undefined => {
  const cur = text.includes(`SINCE ${curSince} `);
  if (text.includes('FROM PageView'))
    return nrqlBody([
      cur
        ? {
            facet: BROWSER,
            pageViews: 500,
            avgLoadSeconds: 2.5,
            sessions: 200,
            jsErrors: 80,
            sessionsWithErrors: 40,
          }
        : {
            facet: BROWSER,
            pageViews: 1000,
            avgLoadSeconds: 1.2,
            sessions: 400,
            jsErrors: 10,
            sessionsWithErrors: 8,
          },
    ]);
  if (text.includes('FROM MobileSession'))
    return nrqlBody([
      cur
        ? { facet: MOBILE, sessions: 300, users: 250, crashes: 30, usersWithCrashes: 25 }
        : { facet: MOBILE, sessions: 320, users: 260, crashes: 3, usersWithCrashes: 3 },
    ]);
  if (text.includes('FROM SyntheticCheck'))
    return nrqlBody([
      {
        facet: [MONITOR, 'AWS_US_EAST_1'],
        checks: 12,
        failures: 3,
        avgDuration: 900,
        lastResult: 'FAILED',
        lastAt: NOW,
        lastError: 'HTTP 500',
      },
    ]);
  return undefined;
};

const RELATED = [
  edge(vertex(BROWSER, A, 'shop web')),
  edge(vertex(MOBILE, B, 'shop app')),
  edge(vertex(MONITOR, A, 'shop ping')),
  edge(vertex(API, A, 'payments', 'CRITICAL')),
  edge(vertex(DB, A, 'orders-db', 'WARNING')),
  edge(vertex(FOREIGN, OTHER, 'foreign')),
];

function nerdGraph() {
  const base = mockNerdGraph();
  const calls: { op: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const op = /query (Rb\w+)/.exec(body.query)?.[1] ?? 'unknown';
    calls.push({ op });
    if (op === 'RbRelatedEntities')
      return json({
        data: {
          actor: {
            entity: {
              guid: body.variables['guid'],
              accountId: A,
              name: 'checkout',
              relatedEntities: { nextCursor: null, results: RELATED },
            },
          },
        },
      });
    if (op === 'RbNrql') {
      const r = answers(String(body.variables['nrql']));
      if (r) return r;
    }
    return base.fetch(url, init);
  };
  return { fetch, calls };
}

const rows = new Map<string, string>();
const store = {
  get: async (k: string) => rows.get(k) ?? null,
  put: async (k: string, v: string) => void rows.set(k, v),
  compareAndPut: async (k: string, e: string, v: string) => {
    if (rows.get(k) !== e) return false;
    rows.set(k, v);
    return true;
  },
};

function setup(budget = 60) {
  rows.clear();
  let now = NOW;
  const ng = nerdGraph();
  const deps = { fetch: ng.fetch, sleep: async () => {} };
  const tools = [...createReportTools(deps), ...createInvestigationTools(deps)];
  const ctx = (extra: Partial<ToolContext> = {}): ToolContext =>
    testContext({
      accounts: { allowed: [A, B], default: A },
      budget: createBudget(budget),
      clock: { now: () => now },
      tasks: { store, owner: 'project:p/grant:g', accepted: true },
      ...extra,
    });
  const def = (name: string) => tools.find((t) => t.name === name) as ToolDefinition;
  return { ng, tools, ctx, def, advance: (ms: number) => (now += ms) };
}

const plain = (x: string | undefined) =>
  (x ?? '')
    .replace(/untrusted-data id="[0-9a-f]+"/g, 'id')
    .replace(/<\/untrusted-data id="[0-9a-f]+">/g, '</id>')
    .replace(/<untrusted-data id="[0-9a-f]+"/g, '<id');

const CASES = [
  {
    name: 'generate_user_impact_report',
    args: { entity_guid: MOCK_GUID },
    firstCalls: [] as string[],
  },
  { name: 'entity_health', args: { entity_guid: MOCK_GUID }, firstCalls: [] as string[] },
  { name: 'dependency_health', args: { entity_guid: MOCK_GUID }, firstCalls: ['RbRelatedEntities'] },
];

describe.each(CASES)('$name as an MCP task (P7-23)', ({ name, args, firstCalls }) => {
  it('completes through polls with the same output as a synchronous call, bounded per poll', async () => {
    const t = setup();
    const def = t.def(name);
    const sync = await def.handler(def.inputSchema.parse(args), t.ctx({ tasks: undefined as never }));
    const syncCalls = t.ng.calls.length;
    t.ng.calls.length = 0;

    const first = t.ctx();
    const out = await def.handler(def.inputSchema.parse(args), first);
    expect(out.task).toBeDefined();
    // The creating request does only the cheap preparation.
    expect(t.ng.calls.map((c) => c.op)).toEqual(firstCalls);
    const created = await createTask(first, name, out.task as TaskJob);
    const opts = { tools: t.tools };

    let seen = await getTask(t.ctx(), created.taskId, opts);
    const steps: number[] = [];
    for (let i = 0; i < 12 && seen.status === 'working'; i++) {
      t.advance(1000);
      const before = t.ng.calls.length;
      seen = await getTask(t.ctx(), created.taskId, opts);
      steps.push(t.ng.calls.length - before);
    }
    expect(seen.status).toBe('completed');
    expect(steps.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
    // Every request is a real call: the task spends exactly what the synchronous call did.
    expect(t.ng.calls.length).toBe(syncCalls);
    const result = seen.result as { structuredContent: unknown; content: { text: string }[] };
    expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(sync.structured)));
    expect(plain(result.content[0]?.text)).toBe(plain(sync.text));
  });

  it('a poll with a tiny budget keeps working instead of skipping what did not fit', async () => {
    const t = setup();
    const def = t.def(name);
    const first = t.ctx();
    const out = await def.handler(def.inputSchema.parse(args), first);
    const created = await createTask(first, name, out.task as TaskJob);
    t.advance(1000);
    const seen = await getTask(t.ctx({ budget: createBudget(2) }), created.taskId, { tools: t.tools });
    expect(seen.status).toBe('working');
  });

  it('a host that cannot store the task still gets the whole answer (taskFallback)', async () => {
    const t = setup();
    const def = t.def(name);
    const out = await def.handler(def.inputSchema.parse(args), t.ctx());
    const full = await out.taskFallback?.();
    expect(full?.structured).toBeDefined();
    const sync = await def.handler(def.inputSchema.parse(args), t.ctx({ tasks: undefined as never }));
    expect(JSON.parse(JSON.stringify(full?.structured))).toEqual(JSON.parse(JSON.stringify(sync.structured)));
  });

  it('without a task binding the answer is synchronous', async () => {
    const t = setup();
    const def = t.def(name);
    const out = await def.handler(def.inputSchema.parse(args), t.ctx({ tasks: { store, owner: 'x' } }));
    expect(out.task).toBeUndefined();
    expect(out.structured).toBeDefined();
  });

  it('fails closed on a tampered state and keeps nothing readable at rest', async () => {
    const t = setup();
    const def = t.def(name);
    const first = t.ctx();
    const out = await def.handler(def.inputSchema.parse(args), first);
    await createTask(first, name, out.task as TaskJob);
    expect([...rows.values()][0]).not.toContain(MOCK_GUID);
    await expect(def.resumeTask?.({ args: { entity_guid: '' } }, t.ctx())).rejects.toThrow();
    await expect(def.resumeTask?.({ ...(out.task?.state as object), extra: 1 }, t.ctx())).rejects.toThrow();
  });

  it('re-checks the account scope of a sealed state on every step', async () => {
    const t = setup();
    const def = t.def(name);
    const first = t.ctx();
    const out = await def.handler(def.inputSchema.parse(args), first);
    const narrow = t.ctx({ accounts: { allowed: [OTHER], default: OTHER } });
    if (name === 'generate_user_impact_report') {
      // The affected entity is no longer in scope: nothing is queried for it.
      t.ng.calls.length = 0;
      const r = await def.resumeTask?.(out.task?.state as never, narrow);
      expect(t.ng.calls).toEqual([]);
      expect(r?.task).toBeUndefined();
    } else {
      await expect(def.resumeTask?.(out.task?.state as never, narrow)).rejects.toMatchObject({
        code: ErrorCode.AuthForbidden,
      });
    }
  });

  it('past the state size cap the rest is skipped and the answer completes', async () => {
    const t = setup();
    const def = t.def(name);
    const first = t.ctx();
    const out = await def.handler(def.inputSchema.parse(args), first);
    const state = JSON.parse(JSON.stringify(out.task?.state)) as Record<string, unknown>;
    const huge = { big: 'x'.repeat(310_000) };
    if (name === 'generate_user_impact_report') state['lookups'] = []; // lookups of no front end; the first step runs, the cap is hit by the size of the notes below
    // Fill the state past the cap with data the step keeps: a finished first part.
    if (name === 'entity_health')
      state['sections'] = [{ name: 'entity', status: 'ok', note: null, data: huge, text: null }];
    if (name === 'dependency_health')
      state['entries'] = [{ guid: MOCK_GUID, granted: 4, status: 'ok', note: null, data: huge }];
    if (name === 'generate_user_impact_report') {
      state['lookups'] = [];
      state['jobs'] = [
        { name: 'cur|browser:' + A, ran: true, note: null, numbers: null, checks: { x: huge }, rowCount: 0 },
      ];
    }
    const r = await def.resumeTask?.(state, t.ctx({ budget: createBudget(60) }));
    // Either it finished with skipped parts, or (impact: pending lookups first) it needs no more than one more poll.
    if (r?.task) {
      const r2 = await def.resumeTask?.(r.task.state as never, t.ctx());
      expect(r2?.task).toBeUndefined();
    }
    const done = r?.task ? await def.resumeTask?.(r.task.state as never, t.ctx()) : r;
    expect(done?.structured).toBeDefined();
    expect(JSON.stringify(done?.structured)).toMatch(/skipped|not_run|not looked up|not run|size limit/);
  });
});
