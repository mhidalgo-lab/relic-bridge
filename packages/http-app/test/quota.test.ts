// SPDX-License-Identifier: Apache-2.0
// P7-12: per-grant quotas. The guard over the atomic counters (hard deny, soft warning, refunds, store failure), the
// whole HTTP path (real calls counted, cache hits and refusals free, rollover), the admin API (set, clear, usage, owner
// boundary, audit) and the audited denials.
import type { Client } from '@modelcontextprotocol/client';
import { setGrantQuota } from '@relic-bridge/auth';
import { createLogger, ErrorCode, type FetchLike, Secret } from '@relic-bridge/core';
import {
  createMemoryStorage,
  type GrantUsageRepository,
  type StoredQuota,
  usagePeriods,
} from '@relic-bridge/storage';
import { describe, expect, it } from 'vitest';
import {
  createAuditRecorder,
  createHttpApp,
  createQuotaGuard,
  mergeHooks,
  type QuotaDenial,
  quotaError,
} from '../src/index.ts';
import { connect, ManualClock, mockNerdGraph, randomAdminToken, seedWorld, T0 } from './fixtures.ts';

const ADMIN = randomAdminToken();
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------------------------

async function guardWorld(quota: StoredQuota, over: { store?: GrantUsageRepository } = {}) {
  const clock = new ManualClock(Date.UTC(2026, 9, 6, 12, 0, 0));
  const storage = createMemoryStorage({ now: () => clock.now() });
  await storage.users.create({ id: 'u', email: 'u@example.com', role: 'owner' });
  await storage.projects.create({ id: 'p', slug: 'p', defaultAccountId: 1, allowedAccountIds: [1] });
  await storage.grants.create({ id: 'g', projectId: 'p', label: 'svc' });
  const denials: QuotaDenial[] = [];
  const warnings: string[] = [];
  const store = over.store ?? storage.grantUsage;
  const make = () =>
    createQuotaGuard({
      store,
      grantId: 'g',
      quota,
      now: () => clock.now(),
      logger: createLogger({ level: 'debug', sink: (l) => warnings.push(l), now: () => 0 }),
      onDenied: (d) => denials.push(d),
    });
  return { clock, storage, denials, logs: warnings, make };
}

const hintOf = (e: { hint?: string } | null | undefined): string | undefined => e?.hint;

describe('quota guard', () => {
  it('counts calls and refuses past the daily cap with the period, cap and reset time only', async () => {
    const w = await guardWorld({ day: { queries: 2 } });
    for (let i = 0; i < 2; i++) await w.make().beforeCall();
    const denied = await w
      .make()
      .beforeCall()
      .then(
        () => null,
        (e: unknown) =>
          e as { code: string; message: string; hint?: string; details: Record<string, unknown> },
      );
    expect(denied?.code).toBe(ErrorCode.LimitQuota);
    expect(denied?.details).toEqual({
      period: 'day',
      measure: 'queries',
      limit: 2,
      resetsAt: '2026-10-07T00:00:00.000Z',
    });
    // Nothing about other grants, the project, the key or the counter itself.
    expect(JSON.stringify([denied?.message, hintOf(denied), denied?.details])).not.toMatch(
      /grant|project|NRAK/i,
    );
    expect(w.denials).toHaveLength(1);
    const day = usagePeriods(w.clock.now()).day;
    expect((await w.storage.grantUsage.get('g', [day]))[day]?.queries).toBe(2);
  });

  it('starts again in the next period', async () => {
    const w = await guardWorld({ day: { queries: 1 }, month: { queries: 100 } });
    await w.make().beforeCall();
    await expect(w.make().beforeCall()).rejects.toMatchObject({ code: 'RB_LIMIT_QUOTA' });
    w.clock.advance(DAY);
    await w.make().beforeCall();
  });

  it('gives back the first period when the second refuses, so a refused call is never counted', async () => {
    const w = await guardWorld({ day: { queries: 10 }, month: { queries: 1 } });
    await w.make().beforeCall();
    await expect(w.make().beforeCall()).rejects.toMatchObject({
      details: { period: 'month' },
    });
    const { day, month } = usagePeriods(w.clock.now());
    const used = await w.storage.grantUsage.get('g', [day, month]);
    expect(used[day]?.queries).toBe(1);
    expect(used[month]?.queries).toBe(1);
  });

  it('warns once a threshold is crossed (default 80%) and only once per request', async () => {
    const w = await guardWorld({ day: { queries: 10 } });
    for (let i = 0; i < 7; i++) {
      const g = w.make();
      await g.beforeCall();
      expect(g.takeWarning()).toBeUndefined();
    }
    const g = w.make();
    await g.beforeCall();
    const warning = g.takeWarning();
    expect(warning).toContain('80%');
    expect(warning).toContain('8 of 10');
    expect(warning).toContain('2026-10-07T00:00:00.000Z');
    expect(g.takeWarning()).toBeUndefined();
  });

  it('honours a custom warning percentage', async () => {
    const w = await guardWorld({ day: { queries: 10 }, warnPercent: 50 });
    const g = w.make();
    for (let i = 0; i < 5; i++) await g.beforeCall();
    expect(g.takeWarning()).toContain('50%');
  });

  it('counts inspected events, warns, and refuses while the budget is reached', async () => {
    const w = await guardWorld({ day: { inspectedEvents: 1000 } });
    const g = w.make();
    expect(g.tracksInspected).toBe(true);
    await g.beforeCall();
    await g.recordInspected(900);
    expect(g.takeWarning()).toContain('inspected-events');
    // The overshoot of one query is allowed: it is only known after the call.
    await w.make().recordInspected(500);
    await expect(w.make().beforeCall()).rejects.toMatchObject({
      details: { period: 'day', measure: 'inspectedEvents', limit: 1000 },
    });
    const { day } = usagePeriods(w.clock.now());
    // The refused attempt was not counted as a call.
    expect((await w.storage.grantUsage.get('g', [day]))[day]).toEqual({ queries: 1, inspected: 1400 });
  });

  it('does not track inspected events without that budget', async () => {
    const w = await guardWorld({ day: { queries: 5 } });
    expect(w.make().tracksInspected).toBe(false);
  });

  it('lets the call through, with one warning in the log, when the counters are unavailable', async () => {
    const w = await guardWorld({ day: { queries: 1 } });
    const broken: GrantUsageRepository = {
      ...w.storage.grantUsage,
      reserve: () => Promise.reject(new Error('D1 is down NRAK-SECRET')),
    };
    const w2 = await guardWorld({ day: { queries: 1 } }, { store: broken });
    const g = w2.make();
    await g.beforeCall();
    await g.beforeCall();
    await g.recordInspected(5);
    expect(w2.logs.filter((l) => l.includes('quota counters unavailable'))).toHaveLength(1);
    expect(w2.logs.join('\n')).not.toContain('NRAK-SECRET');
  });

  it('names the period in words in the error', () => {
    const e = quotaError({ period: 'month', measure: 'queries', limit: 5, resetsAt: Date.UTC(2026, 10, 1) });
    expect(e.message).toContain('monthly');
    expect(e.hint).toContain('2026-11-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole HTTP path and the admin API
// ---------------------------------------------------------------------------------------------------------------

async function appWorld(over: { fetch?: FetchLike; accessCacheTtlMs?: number } = {}) {
  const world = await seedWorld(createMemoryStorage({ now: () => T0 }));
  const nerdGraph = mockNerdGraph();
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l), now: () => world.clock.now() });
  const recorder = createAuditRecorder({ storage: world.storage, logger, clock: world.clock });
  const app = createHttpApp({
    storage: world.storage,
    keyring: world.keyring,
    clock: world.clock,
    fetch: over.fetch ?? nerdGraph.fetch,
    logger,
    accessCacheTtlMs: over.accessCacheTtlMs ?? 0,
    hooks: mergeHooks(recorder.hooks),
    admin: { token: new Secret(ADMIN), storage: world.storage, audit: recorder },
  });
  return { world, nerdGraph, app, logs };
}

type TestApp = Awaited<ReturnType<typeof appWorld>>;

async function api(t: TestApp, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await t.app.fetch(
    new Request(`http://localhost/api/admin/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${ADMIN}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response JSON, asserted field by field
  return { status: res.status, json: text === '' ? null : (JSON.parse(text) as Record<string, any>) };
}

const textOf = (r: Awaited<ReturnType<Client['callTool']>>): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

describe('quotas over HTTP', () => {
  it('counts real NerdGraph calls, refuses past the cap with RB_LIMIT_QUOTA, and starts again the next day', async () => {
    const t = await appWorld();
    await setGrantQuota(t.world.storage, t.world.grantIds.prod, { day: { queries: 3 }, warnPercent: 60 });
    const client = await connect(t.app, 'prod', t.world.tokens.prod, 'modern');
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await client.callTool({ name: 'whoami', arguments: {} });
      expect(r.isError).toBeFalsy();
      texts.push(textOf(r));
    }
    const calls = t.nerdGraph.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);
    // The soft warning rides on the result that crossed the threshold, outside the data.
    expect(texts[1]).toContain('Quota warning');
    expect(texts[0]).not.toContain('Quota warning');
    const denied = await client.callTool({ name: 'whoami', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain('RB_LIMIT_QUOTA');
    expect(textOf(denied)).toContain('daily');
    expect((denied._meta as Record<string, { code: string }>)['relic-bridge/error']?.code).toBe(
      'RB_LIMIT_QUOTA',
    );
    // No call reached New Relic for the refused one, and no foreign data is in the message.
    expect(t.nerdGraph.calls).toHaveLength(calls);
    expect(textOf(denied)).not.toMatch(/prod|NRAK|grt_/);
    // Other grants are not affected (the eu grant has none).
    const eu = await connect(t.app, 'eu', t.world.tokens.eu, 'modern');
    expect((await eu.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
    // Next UTC day: the counters start again.
    t.world.clock.advance(DAY);
    expect((await client.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
    await client.close();
    await eu.close();
  });

  it('calls refused before New Relic (listing tools, an account the grant does not have) are not counted', async () => {
    const t = await appWorld();
    await setGrantQuota(t.world.storage, t.world.grantIds.prod, { day: { queries: 1 } });
    const client = await connect(t.app, 'prod', t.world.tokens.prod, 'modern');
    await client.listTools();
    await client
      .callTool({
        name: 'run_nrql',
        arguments: { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago', accounts: [999] },
      })
      .catch(() => undefined);
    const day = usagePeriods(t.world.clock.now()).day;
    expect(t.nerdGraph.calls).toHaveLength(0);
    expect(await t.world.storage.grantUsage.get(t.world.grantIds.prod, [day])).toEqual({});
    await client.close();
  });

  it('audits the first denial of a grant (rate-capped) next to the ordinary tool_call error rows', async () => {
    const t = await appWorld();
    await setGrantQuota(t.world.storage, t.world.grantIds.prod, { day: { queries: 1 } });
    const client = await connect(t.app, 'prod', t.world.tokens.prod, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    for (let i = 0; i < 4; i++) await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    await new Promise((r) => setTimeout(r, 20));
    const rows = await t.world.storage.auditLog.list({ limit: 100 });
    const quotaRows = rows.filter((r) => r.action === 'quota.denied');
    expect(quotaRows).toHaveLength(1);
    expect(quotaRows[0]).toMatchObject({
      kind: 'auth',
      status: 'denied',
      grantId: t.world.grantIds.prod,
      errorCode: 'RB_LIMIT_QUOTA',
      details: { period: 'day', measure: 'queries', limit: 1 },
    });
    expect(rows.filter((r) => r.kind === 'tool_call' && r.errorCode === 'RB_LIMIT_QUOTA')).toHaveLength(4);
  });

  it('a grant without a quota is never counted', async () => {
    const t = await appWorld();
    const client = await connect(t.app, 'prod', t.world.tokens.prod, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    const { day, month } = usagePeriods(t.world.clock.now());
    expect(await t.world.storage.grantUsage.get(t.world.grantIds.prod, [day, month])).toEqual({});
    await client.close();
  });
});

describe('quota admin API', () => {
  it('sets, shows, lists usage and clears a quota, with audit rows', async () => {
    const t = await appWorld();
    const id = t.world.grantIds.prod;
    const quota = {
      day: { queries: 100, inspectedEvents: 5_000_000 },
      month: { queries: 2000 },
      warnPercent: 90,
    };
    const set = await api(t, `/grants/${id}/quota`, { method: 'PUT', body: { quota } });
    expect(set.status).toBe(200);
    expect(set.json?.['data'].quota).toEqual(quota);
    expect((await api(t, `/grants/${id}`)).json?.['data'].quota).toEqual(quota);

    const client = await connect(t.app, 'prod', t.world.tokens.prod, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    const usage = await api(t, '/usage/quotas');
    expect(usage.status).toBe(200);
    expect(usage.json?.['truncated']).toBe(false);
    expect(usage.json?.['data']).toHaveLength(1);
    expect(usage.json?.['data'][0]).toMatchObject({
      grantId: id,
      quota,
      day: { period: usagePeriods(t.world.clock.now()).day, queries: 1, inspected: 0 },
      month: { queries: 1 },
    });

    const cleared = await api(t, `/grants/${id}/quota`, { method: 'PUT', body: { quota: null } });
    expect(cleared.json?.['data'].quota).toBeNull();
    expect((await api(t, '/usage/quotas')).json?.['data']).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    const rows = (await t.world.storage.auditLog.list({ limit: 100 })).filter(
      (r) => r.action === 'grant.quota_set',
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.details?.['removed']).sort()).toEqual([false, true]);
    expect(rows[1]?.details?.['quota']).toEqual(quota);
  });

  it('applies a changed quota to the next call at once (access cache cleared on change)', async () => {
    const t = await appWorld({ accessCacheTtlMs: 30_000 });
    const id = t.world.grantIds.prod;
    const client = await connect(t.app, 'prod', t.world.tokens.prod, 'modern');
    const whoami = async () => (await client.callTool({ name: 'whoami', arguments: {} })).isError === true;
    expect(await whoami()).toBe(false);
    await api(t, `/grants/${id}/quota`, { method: 'PUT', body: { quota: { day: { queries: 1 } } } });
    expect(await whoami()).toBe(false);
    expect(await whoami()).toBe(true);
    // Raising the cap frees the connection straight away; the counter was kept.
    await api(t, `/grants/${id}/quota`, { method: 'PUT', body: { quota: { day: { queries: 3 } } } });
    expect(await whoami()).toBe(false);
    // Removing it frees it for good.
    await api(t, `/grants/${id}/quota`, { method: 'PUT', body: { quota: null } });
    expect(await whoami()).toBe(false);
    await client.close();
  });

  it('refuses malformed quotas and unknown grants', async () => {
    const t = await appWorld();
    const id = t.world.grantIds.prod;
    const bad: unknown[] = [
      {},
      { quota: {} },
      { quota: { day: {} } },
      { quota: { day: { queries: 0 } } },
      { quota: { day: { queries: -1 } } },
      { quota: { day: { queries: 1.5 } } },
      { quota: { day: { queries: '5' } } },
      { quota: { day: { queries: 1_000_000_000_000_001 } } },
      { quota: { week: { queries: 5 } } },
      { quota: { day: { queries: 5, extra: 1 } } },
      { quota: { day: { queries: 5 }, warnPercent: 100 } },
      { quota: { day: { queries: 5 }, warnPercent: 0 } },
      { quota: { month: { queries: 5 } }, extra: true },
    ];
    for (const body of bad) {
      expect((await api(t, `/grants/${id}/quota`, { method: 'PUT', body })).status).toBe(400);
    }
    expect((await api(t, '/grants/grt_missing/quota', { method: 'PUT', body: { quota: null } })).status).toBe(
      404,
    );
    expect((await t.world.storage.grants.get(id))?.quota).toBeNull();
  });

  it('accepts a quota when a grant is created and shows it', async () => {
    const t = await appWorld();
    const res = await api(t, '/grants', {
      method: 'POST',
      body: {
        projectId: t.world.projectIds.prod,
        label: 'ci',
        tools: ['whoami'],
        quota: { month: { queries: 50 } },
      },
    });
    expect(res.status).toBe(201);
    expect(res.json?.['data'].quota).toEqual({ month: { queries: 50 } });
    const bad = await api(t, '/grants', {
      method: 'POST',
      body: { projectId: t.world.projectIds.prod, label: 'ci2', quota: { day: { queries: 0 } } },
    });
    expect(bad.status).toBe(400);
  });

  it('keeps an owner’s grant out of an administrator’s hands (owner boundary)', async () => {
    const t = await appWorld();
    // The seeded grant belongs to an owner (usr_a). Through the admin token (owner role) it works; the session path is
    // covered by the authz suite and the admin-ui tests: here we check the audit trail names the target.
    const id = t.world.grantIds.prod;
    await api(t, `/grants/${id}/quota`, { method: 'PUT', body: { quota: { day: { queries: 5 } } } });
    await new Promise((r) => setTimeout(r, 20));
    const row = (await t.world.storage.auditLog.list({ limit: 20 })).find(
      (r) => r.action === 'grant.quota_set',
    );
    expect(row).toMatchObject({ kind: 'admin', targetType: 'grant', targetId: id, status: 'ok' });
  });

  it('bounds the usage view to 50 grants', async () => {
    const t = await appWorld();
    for (let i = 0; i < 52; i++) {
      await t.world.storage.grants.create({
        id: `grt_bulk_${i}`,
        projectId: t.world.projectIds.prod,
        label: `bulk ${i}`,
        quota: { day: { queries: 5 } },
      });
    }
    const usage = await api(t, '/usage/quotas');
    expect(usage.json?.['data']).toHaveLength(50);
    expect(usage.json?.['truncated']).toBe(true);
  });
});
