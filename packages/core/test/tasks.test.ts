// SPDX-License-Identifier: Apache-2.0
// MCP Tasks core (P7-13, THREAT_MODEL T32): sealed, owner-bound, expiring task records and the one-step resume.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  answerTaskRpc,
  buildMcpServer,
  cancelTask,
  clientDeclaresTasks,
  createBudget,
  createMemoryTaskStore,
  createTask,
  defineTool,
  ErrorCode,
  getTask,
  MAX_TASK_RECORD_BYTES,
  RbError,
  TASK_ID_RE,
  TASK_TTL_MS,
  TaskNotFoundError,
  type TaskStore,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
  updateTask,
} from '../src/index.ts';
import { testContext } from './helpers/context.ts';

function memoryStore(): TaskStore & { rows: Map<string, string>; ttls: number[] } {
  const rows = new Map<string, string>();
  const ttls: number[] = [];
  return {
    rows,
    ttls,
    get: async (key) => rows.get(key) ?? null,
    put: async (key, value, options) => {
      rows.set(key, value);
      ttls.push(options.expirationTtl);
    },
    compareAndPut: async (key, expected, value, options) => {
      if (rows.get(key) !== expected) return false;
      rows.set(key, value);
      ttls.push(options.expirationTtl);
      return true;
    },
  };
}

function world(owner = 'project:p/grant:g/token:t/client:-') {
  const store = memoryStore();
  let now = 1_800_000_000_000;
  const clock = { now: () => now };
  const ctx = (who = owner, extra: Partial<ToolContext> = {}): ToolContext =>
    testContext({ clock, budget: createBudget(10), tasks: { store, owner: who }, ...extra });
  return { store, ctx, advance: (ms: number) => (now += ms) };
}

/** A tool whose steps are scripted: each `resumeTask` call takes the next step. */
function scripted(steps: (() => Promise<ToolOutput>)[]): ToolDefinition {
  let i = 0;
  return defineTool({
    name: 'slow',
    title: 'Slow',
    description: 'test',
    inputSchema: z.object({}),
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'test',
    phase: 7,
    handler: async () => ({ text: 'x' }),
    resumeTask: async () => {
      const step = steps[i++];
      if (step === undefined) throw new Error('no more steps');
      return step();
    },
  }) as ToolDefinition;
}

const working = (n: number): ToolOutput => ({
  text: 'running',
  task: { state: { n }, pollIntervalMs: 1000, statusMessage: `step ${n}` },
});

describe('clientDeclaresTasks', () => {
  it('needs an object entry under extensions in the client capabilities', () => {
    const caps = (extensions: unknown) => ({ 'io.modelcontextprotocol/clientCapabilities': { extensions } });
    expect(clientDeclaresTasks(caps({ 'io.modelcontextprotocol/tasks': {} }))).toBe(true);
    for (const meta of [
      undefined,
      null,
      {},
      caps(undefined),
      caps({}),
      caps({ 'io.modelcontextprotocol/tasks': true }),
      caps({ 'io.modelcontextprotocol/tasks': [] }),
      { 'io.modelcontextprotocol/tasks': {} },
    ]) {
      expect(clientDeclaresTasks(meta), JSON.stringify(meta)).toBe(false);
    }
  });
});

describe('task records', () => {
  it('ids are 256-bit random; only a hash is the key; the value is sealed', async () => {
    const w = world();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const task = await createTask(w.ctx(), 'slow', { state: { secret: 'q-123' }, pollIntervalMs: 1500 });
      expect(task.taskId).toMatch(TASK_ID_RE);
      ids.add(task.taskId);
    }
    expect(ids.size).toBe(20);
    for (const [key, value] of w.store.rows) {
      expect(key).toMatch(/^task:[0-9a-f]{64}$/);
      for (const id of ids) {
        expect(key).not.toContain(id);
        expect(value).not.toContain(id);
      }
      expect(value).not.toContain('q-123');
      expect(value).not.toContain('grant:g');
    }
    expect(new Set(w.store.ttls)).toEqual(new Set([TASK_TTL_MS / 1000]));
  });

  it('another owner, a tampered record, a swapped record or an expired one is "not found"', async () => {
    const w = world();
    const a = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    const b = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    const opts = { tools: [scripted([])] };
    await expect(getTask(w.ctx('project:p/grant:g/token:OTHER/client:-'), a.taskId, opts)).rejects.toThrow(
      TaskNotFoundError,
    );
    await expect(cancelTask(w.ctx('project:p/grant:g2/token:t/client:-'), a.taskId)).rejects.toThrow(
      TaskNotFoundError,
    );
    await expect(updateTask(w.ctx('project:q/grant:g/token:t/client:-'), a.taskId)).rejects.toThrow(
      TaskNotFoundError,
    );
    await expect(getTask(w.ctx(), 'A'.repeat(43), opts)).rejects.toThrow(TaskNotFoundError);
    await expect(getTask(w.ctx(), 42, opts)).rejects.toThrow(TaskNotFoundError);

    // Swap the sealed values: each id opens only its own record.
    const [ka, kb] = [...w.store.rows.keys()] as [string, string];
    const [va, vb] = [w.store.rows.get(ka) as string, w.store.rows.get(kb) as string];
    w.store.rows.set(ka, vb);
    w.store.rows.set(kb, va);
    await expect(getTask(w.ctx(), a.taskId, opts)).rejects.toThrow(TaskNotFoundError);
    w.store.rows.set(ka, `${va.slice(0, -4)}AAAA`);
    await expect(getTask(w.ctx(), a.taskId, opts)).rejects.toThrow(TaskNotFoundError);
    w.store.rows.set(kb, vb);
    expect((await getTask(w.ctx(), b.taskId, opts)).status).toBe('working');
    w.advance(TASK_TTL_MS);
    await expect(getTask(w.ctx(), b.taskId, opts)).rejects.toThrow(TaskNotFoundError);
  });
});

describe('getTask', () => {
  it('does one step per poll, never before the poll interval, and stores the final result', async () => {
    const w = world();
    const tool = scripted([async () => working(1), async () => ({ text: 'done', structured: { ok: true } })]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: { n: 0 }, pollIntervalMs: 1000 });
    expect((await getTask(w.ctx(), taskId, { tools: [tool] })).statusMessage).toBeUndefined();
    w.advance(1000);
    expect(await getTask(w.ctx(), taskId, { tools: [tool] })).toMatchObject({
      status: 'working',
      statusMessage: 'step 1',
    });
    w.advance(1000);
    const done = await getTask(w.ctx(), taskId, { tools: [tool] });
    expect(done).toMatchObject({
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true } },
    });
    w.advance(5000);
    expect(await getTask(w.ctx(), taskId, { tools: [tool] })).toEqual(done);
  });

  it('clamps the poll interval to 1-10 s', async () => {
    const w = world();
    expect((await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 5 })).pollIntervalMs).toBe(1000);
    expect((await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 9e9 })).pollIntervalMs).toBe(
      10_000,
    );
    expect(
      (await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: Number.NaN })).pollIntervalMs,
    ).toBe(1000);
  });

  it('transient errors keep it working; other errors complete it with the tool error result', async () => {
    const w = world();
    const tool = scripted([
      async () => {
        throw new RbError(ErrorCode.NerdGraphUnavailable, 'down');
      },
      async () => {
        throw new RbError(ErrorCode.InputInvalid, 'bad query');
      },
    ]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    w.advance(1000);
    expect(await getTask(w.ctx(), taskId, { tools: [tool] })).toMatchObject({
      status: 'working',
      statusMessage: expect.stringContaining('RB_NERDGRAPH_UNAVAILABLE'),
    });
    w.advance(1000);
    const done = await getTask(w.ctx(), taskId, { tools: [tool] });
    expect(done).toMatchObject({ status: 'completed', result: { isError: true } });
    expect(JSON.stringify(done.result)).toContain('RB_INPUT_INVALID');
  });

  it('a tool that is no longer granted completes it with RB_AUTH_FORBIDDEN without running', async () => {
    const w = world();
    const { taskId } = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    w.advance(1000);
    const done = await getTask(w.ctx(), taskId, { tools: [] });
    expect(JSON.stringify(done.result)).toContain('RB_AUTH_FORBIDDEN');
  });

  it('leaves the task untouched when the request budget cannot cover a step', async () => {
    const w = world();
    let ran = 0;
    const tool = scripted([
      async () => {
        ran++;
        return { text: 'done' };
      },
    ]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    w.advance(1000);
    // One unit: the lookup. Nothing left for the step and its write.
    const res = await getTask(w.ctx(undefined, { budget: createBudget(1) }), taskId, { tools: [tool] });
    expect(res.status).toBe('working');
    expect(ran).toBe(0);
  });

  it('a result too large to keep completes with RB_LIMIT_RESPONSE_TOO_LARGE', async () => {
    const w = world();
    const tool = scripted([async () => ({ text: 'x'.repeat(MAX_TASK_RECORD_BYTES) })]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    w.advance(1000);
    await getTask(w.ctx(), taskId, { tools: [tool] });
    const stored = await getTask(w.ctx(), taskId, { tools: [tool] });
    expect(stored.status).toBe('completed');
    expect(JSON.stringify(stored.result)).toContain('RB_LIMIT_RESPONSE_TOO_LARGE');
  });

  it('reports each step to the observer without the state', async () => {
    const w = world();
    const events: unknown[] = [];
    const tool = scripted([async () => ({ text: 'done', meta: { m: 1 } })]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: { queryId: 'q' }, pollIntervalMs: 1000 });
    w.advance(1000);
    await getTask(w.ctx(), taskId, { tools: [tool], onToolCall: (e) => events.push(e) });
    expect(events).toEqual([
      expect.objectContaining({ tool: 'slow', status: 'ok', input: { task: true }, meta: { m: 1 } }),
    ]);
  });
});

describe('compare-and-swap on task records (P7-29)', () => {
  /** `n` readers all see the stored value before any of them may continue (a deterministic race). */
  function barrier(w: ReturnType<typeof world>, n: number) {
    const get = w.store.get;
    let waiting = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let armed = true;
    w.store.get = async (key) => {
      const value = await get(key);
      if (!armed) return value;
      if (++waiting >= n) {
        armed = false;
        release();
      }
      await gate;
      return value;
    };
  }

  it('two concurrent polls of one task run one step', async () => {
    const w = world();
    let ran = 0;
    const tool = scripted([
      async () => {
        ran++;
        return working(1);
      },
      async () => {
        ran++;
        return working(2);
      },
    ]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: { n: 0 }, pollIntervalMs: 1000 });
    w.advance(1000);
    barrier(w, 2);
    const results = await Promise.all([
      getTask(w.ctx(), taskId, { tools: [tool] }),
      getTask(w.ctx(), taskId, { tools: [tool] }),
    ]);
    expect(ran).toBe(1);
    expect(results.map((r) => r.status)).toEqual(['working', 'working']);
    // The loser answers with what is stored (the claim), and neither poll charged a second step.
    expect(results[0]?.statusMessage).toBe('step 1');
    expect(results[1]?.statusMessage).toBeUndefined();
    w.advance(1000);
    expect((await getTask(w.ctx(), taskId, { tools: [tool] })).statusMessage).toBe('step 2');
    expect(ran).toBe(2);
  });

  it('a cancel during a poll stays cancelled', async () => {
    const w = world();
    let release: () => void = () => {};
    const inStep = new Promise<void>((r) => (release = r));
    let finish: () => void = () => {};
    const hold = new Promise<void>((r) => (finish = r));
    const tool = scripted([
      async () => {
        release();
        await hold;
        return { text: 'done' };
      },
    ]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    w.advance(1000);
    const poll = getTask(w.ctx(), taskId, { tools: [tool] });
    await inStep;
    await cancelTask(w.ctx(), taskId);
    finish();
    expect(await poll).toMatchObject({ status: 'cancelled' });
    w.advance(5000);
    expect(await getTask(w.ctx(), taskId, { tools: [tool] })).toMatchObject({ status: 'cancelled' });
  });

  it('a cancel that races a poll claim still cancels (it retries on the new value)', async () => {
    const w = world();
    const tool = scripted([async () => working(1)]);
    const { taskId } = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    w.advance(1000);
    barrier(w, 2);
    await Promise.all([getTask(w.ctx(), taskId, { tools: [tool] }), cancelTask(w.ctx(), taskId)]);
    w.advance(5000);
    expect((await getTask(w.ctx(), taskId, { tools: [tool] })).status).toBe('cancelled');
  });
});

describe('cancelTask', () => {
  it('cancels a working task once and keeps terminal states', async () => {
    const w = world();
    const tool = scripted([async () => ({ text: 'done' })]);
    const a = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    await cancelTask(w.ctx(), a.taskId);
    w.advance(1000);
    expect((await getTask(w.ctx(), a.taskId, { tools: [tool] })).status).toBe('cancelled');
    const b = await createTask(w.ctx(), 'slow', { state: {}, pollIntervalMs: 1000 });
    w.advance(1000);
    await getTask(w.ctx(), b.taskId, { tools: [tool] });
    await cancelTask(w.ctx(), b.taskId);
    expect((await getTask(w.ctx(), b.taskId, { tools: [tool] })).status).toBe('completed');
  });
});

describe('buildMcpServer', () => {
  it('advertises the extension only for a per-request context with a task binding (never stdio factories)', () => {
    const w = world();
    const caps = (ctx: ToolContext | (() => ToolContext)) =>
      (
        buildMcpServer({ tools: [scripted([])], ctx }) as unknown as {
          server: { getCapabilities(): Record<string, unknown> };
        }
      ).server.getCapabilities();
    expect(caps(w.ctx())).toMatchObject({ extensions: { 'io.modelcontextprotocol/tasks': {} } });
    expect(caps(() => w.ctx())['extensions']).toBeUndefined();
    expect(caps(testContext())['extensions']).toBeUndefined();
    // stdio (P7-22): a factory host that answers tasks/* itself asks for the extension explicitly.
    const offered = buildMcpServer({
      tools: [scripted([])],
      ctx: () => w.ctx(),
      offerTasks: true,
    }) as unknown as {
      server: { getCapabilities(): Record<string, unknown> };
    };
    expect(offered.server.getCapabilities()).toMatchObject({
      extensions: { 'io.modelcontextprotocol/tasks': {} },
    });
  });
});

describe('createMemoryTaskStore (P7-22)', () => {
  it('expires rows, drops the oldest above the bound and rejects a bad bound', async () => {
    let now = 0;
    const store = createMemoryTaskStore({ maxEntries: 2, now: () => now });
    await store.put('a', '1', { expirationTtl: 10 });
    await store.put('b', '2', { expirationTtl: 10 });
    await store.put('c', '3', { expirationTtl: 10 });
    expect(await store.get('a')).toBeNull();
    expect(await store.get('b')).toBe('2');
    now = 10_000;
    expect(await store.get('b')).toBeNull();
    expect(await store.get('c')).toBeNull();
    expect(() => createMemoryTaskStore({ maxEntries: 0 })).toThrow(RangeError);
  });

  it('tasks on it are still sealed and owner-bound', async () => {
    const store = createMemoryTaskStore();
    const ctx = (owner: string) => testContext({ budget: createBudget(10), tasks: { store, owner } });
    const tool = scripted([async () => ({ text: 'done' })]);
    const task = await createTask(ctx('stdio'), 'slow', {
      state: { secret: 'S3CRET' },
      pollIntervalMs: 1000,
    });
    await expect(getTask(ctx('other'), task.taskId, { tools: [tool] })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect((await getTask(ctx('stdio'), task.taskId, { tools: [tool] })).taskId).toBe(task.taskId);
  });
});

describe('answerTaskRpc (P7-22)', () => {
  const meta = (tasks: boolean) => ({
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': tasks
      ? { extensions: { 'io.modelcontextprotocol/tasks': {} } }
      : {},
  });
  const request = (taskId: unknown, tasks = true, method = 'tasks/get') => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { taskId, _meta: meta(tasks) },
  });

  it('answers a not-found, a missing capability and bad shapes without work', async () => {
    const w = world();
    const options = { ctx: w.ctx(), resume: { tools: [] }, log: {} };
    const missing = await answerTaskRpc(request('A'.repeat(43)), options);
    expect(missing.body['error']).toMatchObject({ code: -32602 });
    expect((await answerTaskRpc(request('A'.repeat(43), false), options)).body['error']).toMatchObject({
      code: -32021,
    });
    expect((await answerTaskRpc(request(7), options)).body['error']).toMatchObject({ code: -32602 });
    expect((await answerTaskRpc([], options)).status).toBe(400);
    const mismatch = await answerTaskRpc(request('A'.repeat(43)), {
      ...options,
      routingMatches: () => false,
    });
    expect(mismatch.body['error']).toMatchObject({ code: -32020 });
  });
});
