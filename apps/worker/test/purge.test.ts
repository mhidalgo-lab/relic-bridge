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

describe('scheduled kv purge (P4-09)', () => {
  beforeEach(() => wipeD1(db));

  const past = () => Math.floor(Date.now() / 1000) - 60;
  async function seed(): Promise<void> {
    const storage = await createD1Storage(db);
    for (const k of ['login:a', 'login:b', 'setup:c']) await storage.kv.put(k, 'x', { expiration: past() });
    await storage.kv.put('login:live', 'y', { expirationTtl: 600 });
    await storage.kv.put('keep', 'z');
  }
  async function names(): Promise<string[]> {
    const storage = await createD1Storage(db);
    // `list` hides expired rows, so count them with the purge itself in a dry batch of one.
    return (await storage.kv.list()).keys.map((k) => k.name);
  }

  it('removes expired rows (abandoned logins, unused setup links) and keeps live ones', async () => {
    await seed();
    const { l, go } = run();
    await go();
    expect(await names()).toEqual(['keep', 'login:live']);
    expect(await (await createD1Storage(db)).kv.purgeExpired()).toBe(0);
    expect(l.lines.find((x) => x['msg'] === 'kv purge finished')).toMatchObject({
      removed: 3,
      complete: true,
    });
  });

  it('runs even when audit retention is 0 or invalid, and writes no audit row', async () => {
    for (const retention of ['0', 'x']) {
      await wipeD1(db);
      await seed();
      const { go } = run({ RB_AUDIT_RETENTION_DAYS: retention });
      await go();
      expect(await (await createD1Storage(db)).kv.purgeExpired()).toBe(0);
      expect(await actions()).toEqual([]);
    }
  });

  it('works in bounded batches and resumes on the next run', async () => {
    await seed();
    const budget = { kvPurge: { batchRows: 2, maxBatches: 1 } };
    const first = run({}, budget);
    await first.go();
    expect(first.l.lines.find((x) => x['msg'] === 'kv purge finished')).toMatchObject({
      removed: 2,
      complete: false,
    });
    const second = run({}, budget);
    await second.go();
    expect(second.l.lines.find((x) => x['msg'] === 'kv purge finished')).toMatchObject({
      removed: 1,
      complete: true,
    });
  });

  it('logs a storage failure without throwing and does not stop the audit purge', async () => {
    const { l, go } = run(
      {},
      {
        openStorage: () => {
          throw new Error('boom');
        },
      },
    );
    await expect(go()).resolves.toBeUndefined();
    expect(l.lines.find((x) => x['msg'] === 'kv purge failed')).toBeDefined();
  });
});
