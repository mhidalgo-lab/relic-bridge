// SPDX-License-Identifier: Apache-2.0
// MCP Tasks authorization (P7-13, THREAT_MODEL T32), on every host of the suite (HTTP app and Worker + D1): a task
// belongs to the device that created it (project, grant, token / OAuth device). Every other caller, whatever it knows,
// gets the answer an unknown id gets, and nothing it sends polls, cancels or reads the task. A revoked token gets no
// answer at all (401), and the pass-through route never serves tasks.
import { revokeAccessToken } from '@relic-bridge/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NR_KEY } from '../fixtures.ts';
import { rpc, startTaskOn, TASKS } from '../tasks-fixtures.ts';
import { createHarness, type Harness } from './harness.ts';

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

  it('the pass-through route offers no tasks: no extension, and tasks/* is unknown there', async () => {
    const app = h.makeApp({ passthrough: {} });
    const a = await h.addTenant('tasks-a');
    const taskId = await startTaskOn(app, a.token.value, SLOW, { slug: 'tasks-a' });
    const send = (method: string, params: Record<string, unknown>) =>
      app.fetch(
        new Request('http://localhost/passthrough/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-newrelic-api-key': NR_KEY,
            'mcp-method': method,
            ...(typeof (params['taskId'] ?? params['name']) === 'string'
              ? { 'mcp-name': String(params['taskId'] ?? params['name']) }
              : {}),
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
                'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS]: {} } },
              },
            },
          }),
        }),
      );
    const discover = await send('server/discover', {});
    expect(discover.status).toBe(200);
    expect(await discover.text()).not.toContain(TASKS);
    const get = (await (await send('tasks/get', { taskId })).json()) as { error?: { code: number } };
    expect(get.error?.code).toBe(-32601);
    // A slow query there is polled inside the call as before (it completes after one poll here), never a task.
    const call = await (await send('tools/call', SLOW)).text();
    expect(call).toContain('"resultType":"complete"');
    expect(call).not.toContain('"resultType":"task"');
  });
});
