// SPDX-License-Identifier: Apache-2.0
// Audit retention on Workers (P3-08): the `scheduled` handler against the local D1 database. Rows past
// `RB_AUDIT_RETENTION_DAYS` go, newer ones stay; the work per run is bounded; failures are logged, never thrown.
import { env } from 'cloudflare:workers';
import type { D1Database, ScheduledController } from '@cloudflare/workers-types';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker, type WorkerOptions } from '../src/worker.ts';
import { fakeCtx, wipeD1 } from './helpers.ts';

const db = env.DB as D1Database;
const DAY = 86_400_000;
const controller = {
  cron: '17 * * * *',
  scheduledTime: Date.now(),
  noRetry: () => {},
} as ScheduledController;

const logs = (): { sink: (line: string) => void; lines: Record<string, unknown>[] } => {
  const lines: Record<string, unknown>[] = [];
  return { sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), lines };
};

async function addRows(count: number, ageDays: number, action: string): Promise<void> {
  const storage = await createD1Storage(db);
  const ts = Date.now() - ageDays * DAY;
  for (let i = 0; i < count; i++) {
    await storage.auditLog.append({ ts: ts + i, kind: 'tool_call', action, status: 'ok' });
  }
}

async function actions(): Promise<string[]> {
  const storage = await createD1Storage(db);
  return (await storage.auditLog.list({ limit: 500 })).map((r) => r.action).sort();
}

function run(vars: Record<string, string> = {}, options: WorkerOptions = {}) {
  const l = logs();
  const worker = createWorker({ logSink: l.sink, ...options });
  const e = { ...env, ...vars } as unknown as WorkerEnv;
  return { l, go: () => worker.scheduled(controller, e, fakeCtx()) };
}

describe('scheduled audit purge', () => {
  beforeEach(() => wipeD1(db));

  it('removes rows older than the retention period and keeps newer ones', async () => {
    await addRows(3, 100, 'old');
    await addRows(2, 10, 'recent');
    const { l, go } = run();
    await go();
    expect(await actions()).toEqual(['audit.purge', 'recent', 'recent']);
    const done = l.lines.find((x) => x['msg'] === 'audit purge finished');
    expect(done).toMatchObject({ removed: 3, retentionDays: 90, complete: true });
    // The purge is recorded as an admin action with its source.
    const storage = await createD1Storage(db);
    const [row] = await storage.auditLog.list({ kind: 'admin' });
    expect(row?.details).toMatchObject({ removed: 3, olderThanDays: 90, source: 'cron' });
  });

  it('honours RB_AUDIT_RETENTION_DAYS and writes no row when nothing was removed', async () => {
    await addRows(2, 10, 'recent');
    await run({ RB_AUDIT_RETENTION_DAYS: '5' }).go();
    expect(await actions()).toEqual(['audit.purge']);
    await run({ RB_AUDIT_RETENTION_DAYS: '5' }).go();
    expect(await actions()).toEqual(['audit.purge']);
  });

  it('deletes in bounded batches and resumes on the next run', async () => {
    await addRows(25, 100, 'old');
    await addRows(1, 1, 'recent');
    const budget = { purge: { batchRows: 10, maxBatches: 2 } };
    const first = run({}, budget);
    await first.go();
    expect((await actions()).filter((a) => a === 'old')).toHaveLength(5);
    expect(first.l.lines.find((x) => x['msg'] === 'audit purge finished')).toMatchObject({
      removed: 20,
      batches: 2,
      complete: false,
    });
    const second = run({}, budget);
    await second.go();
    expect(await actions()).toEqual(['audit.purge', 'audit.purge', 'recent']);
    expect(second.l.lines.find((x) => x['msg'] === 'audit purge finished')).toMatchObject({
      removed: 5,
      complete: true,
    });
  });

  it('stops starting batches once the time budget is spent', async () => {
    await addRows(30, 100, 'old');
    let t = 0;
    const { l, go } = run({}, { now: () => (t += 600), purge: { batchRows: 10, budgetMs: 1000 } });
    await go();
    expect(l.lines.find((x) => x['msg'] === 'audit purge finished')).toMatchObject({ complete: false });
    expect((await actions()).filter((a) => a === 'old').length).toBeGreaterThan(0);
  });

  it('keeps everything when retention is 0', async () => {
    await addRows(2, 1000, 'old');
    const { l, go } = run({ RB_AUDIT_RETENTION_DAYS: '0' });
    await go();
    expect(await actions()).toEqual(['old', 'old']);
    expect(l.lines.some((x) => x['msg'] === 'audit purge skipped')).toBe(true);
  });

  it('logs an invalid retention value and deletes nothing', async () => {
    await addRows(2, 1000, 'old');
    const { l, go } = run({ RB_AUDIT_RETENTION_DAYS: 'x' });
    await expect(go()).resolves.toBeUndefined();
    expect(await actions()).toEqual(['old', 'old']);
    expect(l.lines.find((x) => x['msg'] === 'audit purge failed')).toMatchObject({
      variable: 'RB_AUDIT_RETENTION_DAYS',
    });
  });

  it('logs a storage failure without throwing', async () => {
    const { l, go } = run(
      {},
      {
        openStorage: () => {
          throw new Error('boom NRAK-SHOULDNOTAPPEAR');
        },
      },
    );
    await expect(go()).resolves.toBeUndefined();
    const failed = l.lines.find((x) => x['msg'] === 'audit purge failed');
    expect(failed).toBeDefined();
    expect(JSON.stringify(l.lines)).not.toContain('NRAK-');
  });

  it('is exported by the deployed entry', async () => {
    const mod = await import('../src/index.ts');
    expect(typeof mod.default.scheduled).toBe('function');
  });
});
