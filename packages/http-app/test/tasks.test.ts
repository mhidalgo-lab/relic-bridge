// SPDX-License-Identifier: Apache-2.0
// MCP Tasks extension (P7-13): a slow `run_nrql` becomes a task for a client that declared the extension, `tasks/get`
// finishes it one poll at a time, and every other client keeps the `queryId` handle. Negative authorization cases are
// in `authz/tasks.test.ts`.
import { setGrantQuota } from '@relic-bridge/auth';
import { TASK_ID_RE, TASK_TTL_MS } from '@relic-bridge/core';
import { describe, expect, it } from 'vitest';
import { connect } from './fixtures.ts';
import { QUERY_ID, RUN, rpc, startTask, TASKS, tasksWorld } from './tasks-fixtures.ts';

const textOf = (result: Record<string, unknown> | undefined): string =>
  ((result?.['content'] as { text: string }[] | undefined) ?? []).map((c) => c.text).join('\n');

describe('server/discover', () => {
  it('advertises the Tasks extension when the host keeps tasks, and not otherwise', async () => {
    const on = await tasksWorld();
    const res = await rpc(on.app, on.world.tokens.prod, 'server/discover', {});
    expect(res.result?.['capabilities']).toMatchObject({ extensions: { [TASKS]: {} } });

    const off = await tasksWorld({ noTasks: true });
    const plain = await rpc(off.app, off.world.tokens.prod, 'server/discover', {});
    expect(JSON.stringify(plain.result?.['capabilities'] ?? {})).not.toContain(TASKS);
  });
});

describe('a slow run_nrql as a task', () => {
  it('returns a task handle after one async submit, then completes through tasks/get', async () => {
    const t = await tasksWorld({ pending: 1 });
    const created = await rpc(t.app, t.world.tokens.prod, 'tools/call', RUN);
    expect(created.status).toBe(200);
    const task = created.result as Record<string, unknown>;
    expect(task).toMatchObject({
      resultType: 'task',
      status: 'working',
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: 2000,
    });
    expect(task['taskId']).toMatch(TASK_ID_RE);
    expect(task['statusMessage']).toContain('still running');
    expect(Date.parse(task['createdAt'] as string)).toBe(t.world.clock.now());
    // One submit, no polling inside the call.
    expect(t.ng.ops).toEqual(['RbNrql']);
    const taskId = task['taskId'] as string;

    // Polled before pollIntervalMs: the stored state, no NerdGraph call.
    const early = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(early.result).toMatchObject({ resultType: 'complete', taskId, status: 'working' });
    expect(t.ng.ops).toEqual(['RbNrql']);

    // One poll per tasks/get: still running, then done.
    t.world.clock.advance(2000);
    const still = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(still.result).toMatchObject({ status: 'working', pollIntervalMs: 2000 });
    expect(t.ng.ops).toEqual(['RbNrql', 'RbNrqlProgress']);

    t.world.clock.advance(2000);
    const done = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(done.result).toMatchObject({ resultType: 'complete', taskId, status: 'completed' });
    expect(done.result?.['pollIntervalMs']).toBeUndefined();
    const result = done.result?.['result'] as Record<string, unknown>;
    // The same result as a synchronous call: enveloped rows, structured content, result metadata.
    expect(textOf(result)).toContain('42');
    expect(textOf(result)).toMatch(/untrusted/i);
    expect(result['structuredContent']).toMatchObject({ status: 'complete', accountIds: [1] });
    expect(JSON.stringify(result['structuredContent'])).toContain('SELECT count(*) FROM Transaction');
    expect(result['_meta']).toHaveProperty(['relic-bridge/result']);
    expect(t.ng.ops).toEqual(['RbNrql', 'RbNrqlProgress', 'RbNrqlProgress']);

    // A completed task answers from storage.
    t.world.clock.advance(60_000);
    const again = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(again.result?.['result']).toEqual(result);
    expect(t.ng.ops).toHaveLength(3);
  });

  it('keeps format, detail and max_rows for the final result', async () => {
    const t = await tasksWorld({ pending: 0 });
    const created = await rpc(t.app, t.world.tokens.prod, 'tools/call', {
      name: 'run_nrql',
      arguments: { ...RUN.arguments, format: 'json' },
    });
    const taskId = created.result?.['taskId'] as string;
    t.world.clock.advance(2000);
    const done = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    const text = textOf(done.result?.['result'] as Record<string, unknown>);
    expect(text, text).toMatch(/"count":\s*42/);
    expect(text).not.toContain('| count |');
  });

  it('a fast query is answered inline even for a Tasks client', async () => {
    const t = await tasksWorld();
    // Cross-account queries run synchronously at New Relic: never a task.
    const res = await rpc(t.app, t.world.tokens.prod, 'tools/call', {
      name: 'run_nrql',
      arguments: { ...RUN.arguments, accounts: [1, 2] },
    });
    expect(res.result?.['resultType']).toBe('complete');
  });

  it('stores only a hash of the id and a sealed record', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    const listed = await t.world.storage.kv.list({ prefix: 'task:' });
    expect(listed.keys).toHaveLength(1);
    const key = listed.keys[0]?.name as string;
    expect(key).toMatch(/^task:[0-9a-f]{64}$/);
    expect(key).not.toContain(taskId);
    const value = (await t.world.storage.kv.get(key)) as string;
    expect(value).toMatch(/^v1\./);
    for (const plain of [taskId, QUERY_ID, 'Transaction', 'run_nrql', t.world.grantIds.prod]) {
      expect(value).not.toContain(plain);
    }
  });

  it('expires after the TTL', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    t.world.clock.advance(TASK_TTL_MS);
    const res = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(res.error).toEqual({ code: -32602, message: 'Failed to retrieve task: Task not found' });
  });

  it('cancel stops a working task; cancelling again or after completion changes nothing', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    const ack = await rpc(t.app, t.world.tokens.prod, 'tasks/cancel', { taskId });
    expect(ack).toEqual({ status: 200, result: { resultType: 'complete' } });
    t.world.clock.advance(5000);
    const got = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(got.result).toMatchObject({ status: 'cancelled' });
    expect(got.result?.['result']).toBeUndefined();
    expect(t.ng.ops).toEqual(['RbNrql']);
    expect((await rpc(t.app, t.world.tokens.prod, 'tasks/cancel', { taskId })).result).toEqual({
      resultType: 'complete',
    });
  });

  it('update is acknowledged (no task ever asks for input) and changes nothing', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    const ack = await rpc(t.app, t.world.tokens.prod, 'tasks/update', {
      taskId,
      inputResponses: { anything: { action: 'accept', content: {} } },
    });
    expect(ack.result).toEqual({ resultType: 'complete' });
    expect((await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId })).result).toMatchObject({
      status: 'working',
    });
  });
});

describe('poll failures', () => {
  it('a NRQL error completes the task with the tool error result (not "failed")', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    t.ng.failNext = 'NRQL Syntax Error: bad';
    t.world.clock.advance(2000);
    const res = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(res.result).toMatchObject({ status: 'completed', result: { isError: true } });
    expect(textOf(res.result?.['result'] as Record<string, unknown>)).toContain('RB_INPUT_INVALID');
  });

  it('a quota denial keeps the task working with a status message, and the next poll resumes', async () => {
    const t = await tasksWorld({ pending: 0 });
    await setGrantQuota(t.world.storage, t.world.grantIds.prod, { day: { queries: 1 } });
    const taskId = await startTask(t);
    t.world.clock.advance(2000);
    const denied = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(denied.result).toMatchObject({ status: 'working' });
    expect(denied.result?.['statusMessage']).toContain('RB_LIMIT_QUOTA');
    // The quota counted the submit; the denied poll never reached New Relic.
    expect(t.ng.ops).toEqual(['RbNrql']);
    await setGrantQuota(t.world.storage, t.world.grantIds.prod, null);
    t.world.clock.advance(2000);
    const done = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(done.result).toMatchObject({ status: 'completed' });
  });

  it('a task whose tool is no longer available completes with RB_AUTH_FORBIDDEN and no New Relic call', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    const project = await t.world.storage.projects.get(t.world.projectIds.prod);
    await t.world.storage.projects.update(t.world.projectIds.prod, {
      limits: { ...(project?.limits ?? {}), rawNrql: false },
    });
    t.world.clock.advance(2000);
    const res = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId });
    expect(res.result).toMatchObject({ status: 'completed', result: { isError: true } });
    expect(textOf(res.result?.['result'] as Record<string, unknown>)).toContain('RB_AUTH_FORBIDDEN');
    expect(t.ng.ops).toEqual(['RbNrql']);
  });
});

describe('fallback: clients without the extension keep the queryId handle', () => {
  it('a 2026-07-28 request without the extension', async () => {
    const t = await tasksWorld();
    t.ng.pending = 99;
    const res = await rpc(t.app, t.world.tokens.prod, 'tools/call', RUN, { tasks: false });
    expect(res.result?.['resultType']).toBe('complete');
    expect(textOf(res.result)).toContain(`get_query_result with query_id "${QUERY_ID}"`);
    expect(await t.world.storage.kv.list({ prefix: 'task:' })).toMatchObject({ keys: [] });
  });

  it('SDK clients of both protocol eras (neither declares the extension)', async () => {
    const t = await tasksWorld({ pending: 99 });
    for (const era of ['legacy', 'modern'] as const) {
      const client = await connect(t.app, 'prod', t.world.tokens.prod, era);
      try {
        const res = await client.callTool(RUN);
        expect(JSON.stringify(res), era).toContain('get_query_result');
        expect(JSON.stringify(res), era).not.toContain('"resultType":"task"');
      } finally {
        await client.close();
      }
    }
  });

  it('a host without a task store answers inline and tasks/* is unknown', async () => {
    const t = await tasksWorld({ noTasks: true, pending: 99 });
    const res = await rpc(t.app, t.world.tokens.prod, 'tools/call', RUN);
    expect(textOf(res.result)).toContain('get_query_result');
    const get = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId: 'x'.repeat(43) });
    expect(get.error?.code).toBe(-32601);
  });

  it('a store that fails at creation falls back to the handle', async () => {
    const t = await tasksWorld({
      taskStore: {
        get: async () => null,
        put: async () => {
          throw new Error('store down');
        },
      },
    });
    const res = await rpc(t.app, t.world.tokens.prod, 'tools/call', RUN);
    expect(res.result?.['resultType']).toBe('complete');
    expect(textOf(res.result)).toContain('get_query_result');
    expect(t.logs.join('\n')).toContain('task not created');
  });
});

describe('protocol checks on tasks/*', () => {
  it('-32021 without the extension in the request capabilities or the 2026-07-28 envelope', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    for (const options of [{ tasks: false }, { version: null }, { version: '2025-11-25' }]) {
      const res = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId }, options);
      expect(res.status, JSON.stringify(options)).toBe(400);
      expect(res.error).toMatchObject({
        code: -32021,
        data: { requiredCapabilities: { extensions: { [TASKS]: {} } } },
      });
    }
  });

  it('-32020 when Mcp-Name does not mirror the task id', async () => {
    const t = await tasksWorld();
    const taskId = await startTask(t);
    for (const mcpName of [null, 'other']) {
      const res = await rpc(t.app, t.world.tokens.prod, 'tasks/get', { taskId }, { mcpName });
      expect(res.status).toBe(400);
      expect(res.error?.code).toBe(-32020);
    }
  });

  it('-32602 without a task id', async () => {
    const t = await tasksWorld();
    const res = await rpc(t.app, t.world.tokens.prod, 'tasks/get', {});
    expect(res.error?.code).toBe(-32602);
  });
});
