// SPDX-License-Identifier: Apache-2.0
// P8-92 (NEW-23): what `initialize` and `server/discover` advertise must be what works over the stateless HTTP
// transport. The Tasks extension is declared per request in the 2026-07-28 `_meta` envelope, so it is offered to that era
// only; no `listChanged` is promised on a server that cannot send a notification (ADR-0005).
import { describe, expect, it } from 'vitest';
import { RUN, rpc, TASKS, tasksWorld } from './tasks-fixtures.ts';

async function legacyInitialize(app: { fetch(r: Request): Response | Promise<Response> }, token: string) {
  const res = await app.fetch(
    new Request('http://localhost/p/prod/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          // A 2025-era client that declares the extension at initialize: there is nowhere to carry it afterwards.
          capabilities: { extensions: { [TASKS]: {} } },
          clientInfo: { name: 'legacy', version: '1' },
        },
      }),
    }),
  );
  const text = await res.text();
  const data = /^data: (.+)$/m.exec(text)?.[1] ?? text;
  return JSON.parse(data) as { result: { capabilities: Record<string, unknown> } };
}

describe('advertised capabilities match what works over HTTP (P8-92)', () => {
  it('2026-07-28: the extension is advertised, and a declaring request gets a task it can poll', async () => {
    const t = await tasksWorld({ pending: 0 });
    const token = t.world.tokens.prod;
    const discover = await rpc(t.app, token, 'server/discover', {});
    expect(discover.result?.['capabilities']).toMatchObject({ extensions: { [TASKS]: {} } });

    const created = await rpc(t.app, token, 'tools/call', RUN);
    expect(created.result).toMatchObject({ resultType: 'task' });
    const taskId = created.result?.['taskId'] as string;
    t.world.clock.advance(2000);
    const polled = await rpc(t.app, token, 'tasks/get', { taskId });
    expect(polled.result).toMatchObject({ status: 'completed' });

    // The capability is read per request: a request that does not declare it gets the plain result and no task.
    const plain = await rpc(t.app, token, 'tools/call', RUN, { tasks: false });
    expect(plain.result?.['resultType']).not.toBe('task');
    const refused = await rpc(t.app, token, 'tasks/get', { taskId }, { tasks: false });
    expect(refused.error?.code).toBe(-32021);
    // `tasks/list` and `tasks/result` are not part of the 2026-07-28 extension and are not offered.
    expect((await rpc(t.app, token, 'tasks/list', {})).error?.code).toBe(-32601);
    expect((await rpc(t.app, token, 'tasks/result', { taskId })).error?.code).toBe(-32601);
  });

  it('2025 era: the extension is not advertised (it cannot work without the per-request envelope)', async () => {
    const t = await tasksWorld();
    const init = await legacyInitialize(t.app, t.world.tokens.prod);
    expect(JSON.stringify(init.result.capabilities)).not.toContain(TASKS);
    expect(init.result.capabilities).toHaveProperty('tools');
  });

  it('no era promises list-change notifications', async () => {
    const t = await tasksWorld();
    const token = t.world.tokens.prod;
    const modern = (await rpc(t.app, token, 'server/discover', {})).result?.['capabilities'] as Record<
      string,
      { listChanged?: boolean } | undefined
    >;
    const legacy = (await legacyInitialize(t.app, token)).result.capabilities as typeof modern;
    for (const caps of [modern, legacy]) {
      for (const area of ['tools', 'prompts', 'resources'] as const) {
        expect(caps[area], area).toBeDefined();
        expect(caps[area]?.listChanged, area).toBe(false);
      }
    }
  });
});
