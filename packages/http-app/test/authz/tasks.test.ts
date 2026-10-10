// SPDX-License-Identifier: Apache-2.0
// MCP Tasks authorization (P7-13, THREAT_MODEL T32), on every host of the suite (HTTP app and Worker + D1): a task
// belongs to the device that created it (project, grant, token / OAuth device). Every other caller, whatever it knows,
// gets the answer an unknown id gets, and nothing it sends polls, cancels or reads the task. A revoked token gets no
// answer at all (401), and the pass-through route serves a task to the key fingerprint that started it only (P7-22).
import { revokeAccessToken } from '@relic-bridge/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NR_KEY } from '../fixtures.ts';
import { rpc, startTaskOn, TASKS } from '../tasks-fixtures.ts';
import { createHarness, guidOf, type Harness, HONEST_ID, NR_KEY_B } from './harness.ts';

const NOT_FOUND = { code: -32602, message: 'Failed to retrieve task: Task not found' };
const METHODS = ['tasks/get', 'tasks/cancel', 'tasks/update'] as const;
const SLOW = {
  name: 'run_nrql',
  arguments: { nrql: "SELECT count(*) FROM Transaction WHERE name = 'SLOW' SINCE 1 hour ago" },
};

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.scan();
});

const progressCalls = () => h.nerdGraph.calls.filter((c) => c.op === 'RbNrqlProgress').length;

describe('tasks are visible to their creator only', () => {
  it('another token of the same grant, another grant and another project all get "not found"', async () => {
    const a = await h.addTenant('tasks-a');
    const taskId = await startTaskOn(h.app, a.token.value, SLOW, { slug: 'tasks-a' });

    const sameGrant = await h.addToken(a.grantId);
    const otherGrant = await h.addToken(await h.addGrant(a.projectId));
    const b = await h.addTenant('tasks-b');
    const callers: [string, string, string][] = [
      ['same grant, other token', sameGrant.value, 'tasks-a'],
      ['same project, other grant', otherGrant.value, 'tasks-a'],
      ['other project', b.token.value, 'tasks-b'],
    ];
    h.world.clock.advance(5000);
    for (const [who, token, slug] of callers) {
      for (const method of METHODS) {
        const res = await rpc(h.app, token, method, { taskId }, { slug });
        expect(res.status, `${who} ${method}`).toBe(200);
        expect(res.error, `${who} ${method}`).toEqual(NOT_FOUND);
        expect(res.result, `${who} ${method}`).toBeUndefined();
      }
    }
    // Nobody else polled New Relic on the creator's behalf or cancelled the task.
    expect(progressCalls()).toBe(0);
    const own = await rpc(h.app, a.token.value, 'tasks/get', { taskId }, { slug: 'tasks-a' });
    expect(own.result).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(own.result)).toContain('alpha');
    expect(progressCalls()).toBe(1);
  });

  it('a foreign task id answers exactly like an unknown or malformed one', async () => {
    const a = await h.addTenant('tasks-a');
    const taskId = await startTaskOn(h.app, a.token.value, SLOW, { slug: 'tasks-a' });
    const other = await h.addToken(a.grantId);
    for (const id of [taskId, 'A'.repeat(43), 'not-a-task', `${taskId}x`]) {
      const res = await rpc(h.app, other.value, 'tasks/get', { taskId: id }, { slug: 'tasks-a' });
      expect(res, id).toEqual({ status: 200, error: NOT_FOUND });
    }
  });

  it('the creator token on another project route is refused before any task lookup (401)', async () => {
    const a = await h.addTenant('tasks-a');
    await h.addTenant('tasks-b');
    const taskId = await startTaskOn(h.app, a.token.value, SLOW, { slug: 'tasks-a' });
    const res = await rpc(h.app, a.token.value, 'tasks/get', { taskId }, { slug: 'tasks-b' });
    expect(res.status).toBe(401);
  });

  it('a revoked token gets 401, not its task', async () => {
    const a = await h.addTenant('tasks-a');
    const taskId = await startTaskOn(h.app, a.token.value, SLOW, { slug: 'tasks-a' });
    await revokeAccessToken(h.world.storage, a.token.id, h.world.clock.now());
    for (const method of METHODS) {
      const res = await rpc(h.app, a.token.value, method, { taskId }, { slug: 'tasks-a' });
      expect(res.status, method).toBe(401);
    }
  });

  it('a request without a token is 401', async () => {
    const a = await h.addTenant('tasks-a');
    const taskId = await startTaskOn(h.app, a.token.value, SLOW, { slug: 'tasks-a' });
    const res = await h.app.fetch(
      new Request('http://localhost/p/tasks-a/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': 'tasks/get',
          'mcp-name': taskId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId } }),
      }),
    );
    expect(res.status).toBe(401);
  });

  describe('pass-through (P7-22): a task belongs to the key fingerprint that started it', () => {
    const PT = 'http://localhost/passthrough/mcp';
    const send = (
      app: { fetch(request: Request): Response | Promise<Response> },
      key: string,
      method: string,
      params: Record<string, unknown>,
      options: { tasks?: boolean; region?: string } = {},
    ) => {
      const name = params['taskId'] ?? params['name'];
      return app.fetch(
        new Request(PT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-newrelic-api-key': key,
            ...(options.region === undefined ? {} : { 'x-newrelic-region': options.region }),
            'mcp-method': method,
            ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
            'mcp-protocol-version': '2026-07-28',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: {
              ...params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'x', version: '1' },
                'io.modelcontextprotocol/clientCapabilities':
                  options.tasks === false ? {} : { extensions: { [TASKS]: {} } },
              },
            },
          }),
        }),
      );
    };
    const json = async (res: Response) =>
      JSON.parse(await res.text()) as {
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
      };

    for (const shared of [true, false]) {
      describe(shared ? 'host task store' : 'in-process store', () => {
        const makeApp = () =>
          shared
            ? h.makeApp({ passthrough: {} })
            : h.makeApp({ passthrough: {}, taskStore: undefined } as unknown as Parameters<
                typeof h.makeApp
              >[0]);

        it('the same key polls and cancels it; every other key, region and route gets "not found"', async (t) => {
          let app: ReturnType<typeof makeApp>;
          try {
            app = makeApp();
          } catch {
            // The Worker host maps its own storage and cannot drop it; the HTTP app host covers this variant.
            t.skip();
            return;
          }
          const discover = await json(await send(app, NR_KEY, 'server/discover', {}));
          expect(JSON.stringify(discover.result)).toContain(TASKS);
          const started = await json(await send(app, NR_KEY, 'tools/call', SLOW));
          expect(started.result?.['resultType']).toBe('task');
          const taskId = started.result?.['taskId'] as string;

          // Other key, same key in another region, a project token on the project route.
          const a = await h.addTenant('tasks-a');
          const strangers: (() => Response | Promise<Response> | ReturnType<typeof rpc>)[] = [
            () => send(app, NR_KEY_B, 'tasks/get', { taskId }),
            () => send(app, NR_KEY_B, 'tasks/cancel', { taskId }),
            () => send(app, NR_KEY_B, 'tasks/update', { taskId }),
            () => send(app, NR_KEY, 'tasks/get', { taskId }, { region: 'EU' }),
            // (the project route has no task store without the host's)
            ...(shared ? [() => rpc(app, a.token.value, 'tasks/get', { taskId }, { slug: 'tasks-a' })] : []),
          ];
          h.world.clock.advance(5000);
          for (const [i, ask] of strangers.entries()) {
            const res = await ask();
            const body = res instanceof Response ? await json(res) : res;
            expect(body.error, `stranger ${i}`).toEqual(NOT_FOUND);
            expect(body.result, `stranger ${i}`).toBeUndefined();
          }
          expect(progressCalls()).toBe(0);

          const polled = await json(await send(app, NR_KEY, 'tasks/get', { taskId }));
          expect(polled.result).toMatchObject({ status: 'completed' });
          // The poll used the caller's own key, and only that one.
          expect(h.nerdGraph.calls.filter((c) => c.op === 'RbNrqlProgress').map((c) => c.apiKey)).toEqual([
            NR_KEY,
          ]);
        });

        it.runIf(shared)('a project task is not readable with a pass-through key', async () => {
          const app = makeApp();
          const a = await h.addTenant('tasks-a');
          const taskId = await startTaskOn(app, a.token.value, SLOW, { slug: 'tasks-a' });
          h.world.clock.advance(5000);
          const res = await json(await send(app, NR_KEY, 'tasks/get', { taskId }));
          expect(res.error).toEqual(NOT_FOUND);
          expect(progressCalls()).toBe(0);
        });
      });
    }

    it('needs the extension in the request, and a task is only created for a client that declared it', async () => {
      const app = h.makeApp({ passthrough: {} });
      const started = await json(await send(app, NR_KEY, 'tools/call', SLOW));
      const taskId = started.result?.['taskId'] as string;
      const refused = await send(app, NR_KEY, 'tasks/get', { taskId }, { tasks: false });
      expect(refused.status).toBe(400);
      expect((await json(refused)).error?.code).toBe(-32021);
      // Without the extension a slow query is polled inside the call as before.
      const call = await (await send(app, NR_KEY, 'tools/call', SLOW, { tasks: false })).text();
      expect(call).toContain('"resultType":"complete"');
      expect(call).not.toContain('"resultType":"task"');
    });

    it('no key (or a malformed one) is the pass-through 401 before any task is looked at', async () => {
      const app = h.makeApp({ passthrough: {} });
      const started = await json(await send(app, NR_KEY, 'tools/call', SLOW));
      const taskId = started.result?.['taskId'] as string;
      for (const key of ['', 'not-a-key']) {
        const res = await send(app, key, 'tasks/get', { taskId });
        expect(res.status).toBe(401);
      }
    });
  });
});

// Composite report tasks (P7-21, P7-23): partial results are New Relic data in the sealed record, one bounded step per
// poll. Each one is visible to its creator only, runs nothing on anyone else's behalf and completes for the creator.
const honest = (domain: string, type: string) => guidOf(1, HONEST_ID, domain, type);
const COMPOSITES = [
  {
    name: 'generate_alert_insights_report',
    arguments: { issue_id: 'issue-alpha-issue', account: 2, sections: ['errors', 'related'] },
    marker: 'Error groups',
  },
  {
    name: 'generate_user_impact_report',
    arguments: { entity_guid: guidOf(1, '42', 'BROWSER', 'APPLICATION') },
    marker: 'User impact',
  },
  { name: 'entity_health', arguments: { entity_guid: honest('APM', 'APPLICATION') }, marker: 'Health of' },
  {
    name: 'dependency_health',
    arguments: { entity_guid: honest('APM', 'APPLICATION') },
    marker: 'measured next to',
  },
] as const;

describe.each(COMPOSITES)('composite report task: $name', (call) => {
  const calls = () => h.nerdGraph.calls.length;
  const REQUEST = { name: call.name, arguments: call.arguments };

  it('is visible to its creator only, and completes for it', async () => {
    const a = await h.addTenant('tasks-a');
    const taskId = await startTaskOn(h.app, a.token.value, REQUEST, { slug: 'tasks-a' });

    const sameGrant = await h.addToken(a.grantId);
    const otherGrant = await h.addToken(await h.addGrant(a.projectId));
    const b = await h.addTenant('tasks-b');
    h.world.clock.advance(5000);
    const before = calls();
    for (const [token, slug] of [
      [sameGrant.value, 'tasks-a'],
      [otherGrant.value, 'tasks-a'],
      [b.token.value, 'tasks-b'],
    ] as const) {
      for (const method of METHODS) {
        const res = await rpc(h.app, token, method, { taskId }, { slug });
        expect(res.error, `${slug} ${method}`).toEqual(NOT_FOUND);
      }
    }
    // Nobody else ran a step on the creator's behalf.
    expect(calls()).toBe(before);

    let own = await rpc(h.app, a.token.value, 'tasks/get', { taskId }, { slug: 'tasks-a' });
    for (let i = 0; i < 12 && own.result?.['status'] === 'working'; i++) {
      h.world.clock.advance(2000);
      own = await rpc(h.app, a.token.value, 'tasks/get', { taskId }, { slug: 'tasks-a' });
    }
    expect(own.result).toMatchObject({ status: 'completed' });
    const text = JSON.stringify(own.result);
    expect(text).toContain(call.marker);
    expect(text).not.toContain('"resultType":"task"');
    // The partial results are enveloped New Relic data, like a synchronous call.
    expect(text).toMatch(/untrusted/i);
  });

  it('a task of a tool the grant lost completes with RB_AUTH_FORBIDDEN and runs no step', async () => {
    const a = await h.addTenant('tasks-a');
    const taskId = await startTaskOn(h.app, a.token.value, REQUEST, { slug: 'tasks-a' });
    await h.world.storage.grants.update(a.grantId, { tools: ['whoami'] });
    h.world.clock.advance(5000);
    const before = calls();
    const res = await rpc(h.app, a.token.value, 'tasks/get', { taskId }, { slug: 'tasks-a' });
    expect(JSON.stringify(res.result)).toContain('RB_AUTH_FORBIDDEN');
    expect(calls()).toBe(before);
  });
});
