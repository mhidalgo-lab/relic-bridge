// SPDX-License-Identifier: Apache-2.0
// Shared harness of the authorization and isolation suite (P2-12): a seeded world with helpers to add the odd states
// (revoked, disabled, unvalidated, …), the app under test with the admin API and the audit recorder, a hostile
// NerdGraph stand-in and a leak scan. Web-standard only (no `node:*`): P3-06 runs the same suite under the Workers pool
// by swapping `makeApp` for the Worker's fetch.
import { createCredential, issueAccessToken } from '@relic-bridge/auth';
import { createLogger, decodeEntityGuid, type FetchLike, type Identity, Secret } from '@relic-bridge/core';
import { type AuditRecord, newId, type StoredLimits } from '@relic-bridge/storage';
import { vi } from 'vitest';
import {
  createAuditRecorder,
  createHttpApp,
  type HttpAppHooks,
  type HttpAppOptions,
} from '../../src/index.ts';
import { NR_KEY, seedWorld, T0, type World } from '../fixtures.ts';

/** Bootstrap admin token of the app under test (≥ 32 printable characters). */
export const ADMIN_TOKEN = `adm-${'m'.repeat(20)}-${'x'.repeat(20)}`;
/** An account every test key can reach at New Relic but no project allows. */
export const FOREIGN = 999;
/** Marks every piece of foreign data the hostile NerdGraph returns; must never reach a client. */
export const LEAK = 'FOREIGN-LEAK';
/** A second key (another tenant), shaped like a User key. */
export const NR_KEY_B = 'NRAK-TENANTBTESTKEY0123456789XYZ';

export const guidOf = (account: number, id = '42', domain = 'APM', type = 'APPLICATION'): string =>
  btoa(`${account}|${domain}|${type}|${id}`).replace(/=+$/, '');

// ---------------------------------------------------------------------------------------------------------------
// Hostile NerdGraph: every key reaches FOREIGN, every list answer mixes in foreign or forged rows, and single-entity
// answers lie about the account. Replies carry the tenant label so cross-tenant mixing is visible.
// ---------------------------------------------------------------------------------------------------------------

export interface NerdGraphCall {
  readonly apiKey: string | null;
  readonly op: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

export interface HostileNerdGraph {
  readonly fetch: FetchLike;
  readonly calls: NerdGraphCall[];
  /** Extra latency per call (ms), to interleave concurrent requests. */
  delayMs: number;
}

const ok = (data: unknown): Response =>
  new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });

const nrqlContainer = (results: unknown[]) => ({
  results,
  metadata: { eventTypes: ['Transaction'], facets: null, messages: null, timeWindow: null },
  totalResult: null,
  otherResult: null,
  queryProgress: { queryId: null, completed: true, retryAfter: null, resultExpiration: null },
});

const entity = (account: number, name: string, guid = guidOf(account, name)) => ({
  guid,
  name,
  accountId: account,
  domain: 'APM',
  type: 'APPLICATION',
  entityType: 'APM_APPLICATION_ENTITY',
  alertSeverity: 'NOT_ALERTING',
  reporting: true,
  tags: [{ key: 'team', values: [name] }],
  goldenMetrics: {
    metrics: [
      { title: name, query: 'FROM Metric SELECT rate(count(apm.service.transaction.duration), 1 minute)' },
    ],
  },
});

const vertex = (account: number, name: string, guid = guidOf(account, name)) => ({
  guid,
  accountId: account,
  entity: { name, domain: 'APM', type: 'APPLICATION', alertSeverity: 'WARNING', reporting: true },
});

/** `tenants`: API key → label shown in that tenant's replies. Unknown keys get an authentication error. */
export function hostileNerdGraph(tenants: Readonly<Record<string, string>>): HostileNerdGraph {
  const calls: NerdGraphCall[] = [];
  const mock: HostileNerdGraph = {
    calls,
    delayMs: 0,
    fetch: async (_url, init) => {
      const apiKey = new Headers(init.headers).get('api-key');
      const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, unknown> };
      const op = /query (Rb\w+)/.exec(body.query)?.[1] ?? 'unknown';
      const variables = body.variables ?? {};
      calls.push({ apiKey, op, variables });
      if (mock.delayMs > 0) await new Promise((r) => setTimeout(r, Math.random() * mock.delayMs));
      const label = apiKey === null ? undefined : tenants[apiKey];
      if (label === undefined) {
        return new Response(JSON.stringify({ errors: [{ message: 'Invalid API key' }] }), { status: 401 });
      }
      const guidAccount = (): number => decodeEntityGuid(String(variables['guid'])).accountId;
      switch (op) {
        case 'RbIdentity':
        case 'RbAccounts':
          return ok({
            actor: {
              user: { id: 7, email: `${label}@example.com`, name: label },
              accounts: [
                ...[1, 2, 3].map((id) => ({ id, name: `${label}-acct-${id}` })),
                { id: FOREIGN, name: `${LEAK}-acct` },
              ],
            },
          });
        case 'RbNrql':
        case 'RbNrqlCrossAccount': {
          const nrql = String(variables['nrql'] ?? '');
          const results = nrql.startsWith('SHOW EVENT TYPES')
            ? [{ eventType: 'Transaction' }, { eventType: `${label}Event` }]
            : nrql.includes('keyset()')
              ? [{ key: `${label}_attr`, type: 'string' }]
              : [{ tenant: label, count: 1 }];
          return ok(
            op === 'RbNrql'
              ? { actor: { account: { nrql: nrqlContainer(results) } } }
              : { actor: { nrql: nrqlContainer(results) } },
          );
        }
        case 'RbNrqlProgress':
          return ok({
            actor: { account: { nrqlQueryProgress: nrqlContainer([{ tenant: label, count: 1 }]) } },
          });
        case 'RbEntitySearch':
          return ok({
            actor: {
              entitySearch: {
                count: 5,
                results: {
                  nextCursor: null,
                  entities: [
                    entity(1, `${label}-entity-1`),
                    entity(2, `${label}-entity-2`),
                    entity(3, `${label}-entity-3`),
                    entity(FOREIGN, `${LEAK}-entity`),
                    // Reported in an allowed account, but the GUID names the foreign one.
                    entity(1, `${LEAK}-forged`, guidOf(FOREIGN, 'forged')),
                  ],
                },
              },
            },
          });
        case 'RbEntityTypes':
          return ok({
            actor: {
              entitySearch: {
                count: 2,
                types: [
                  { domain: 'APM', type: 'APPLICATION', entityType: 'APM_APPLICATION_ENTITY', count: 1 },
                  { domain: 'EXT', type: label.toUpperCase(), entityType: null, count: 1 },
                ],
              },
            },
          });
        case 'RbRelatedEntities': {
          const account = guidAccount();
          const self = { ...vertex(account, 'self'), guid: variables['guid'] };
          return ok({
            actor: {
              entity: {
                guid: variables['guid'],
                accountId: account,
                name: `${label}-self`,
                relatedEntities: {
                  nextCursor: null,
                  results: [
                    { type: 'CALLS', source: self, target: vertex(2, `${label}-rel`) },
                    {
                      type: 'CALLS',
                      source: self,
                      target: vertex(FOREIGN, `${LEAK}-rel`),
                    },
                    {
                      type: 'CALLS',
                      source: self,
                      target: vertex(1, `${LEAK}-rel-forged`, guidOf(FOREIGN, 'forged')),
                    },
                  ],
                },
              },
            },
          });
        }
        // A single entity in the foreign account behind an allowed account's GUID.
        case 'RbEntity':
        case 'RbGoldenMetrics':
          return ok({ actor: { entity: entity(FOREIGN, `${LEAK}-entity`, String(variables['guid'])) } });
        default:
          throw new Error(`hostileNerdGraph: no reply for ${op}`);
      }
    },
  };
  return mock;
}

/** Every account a NerdGraph call names: account variables, entity-search filters and GUIDs. */
export function accountsNamed(call: NerdGraphCall): number[] {
  const out: number[] = [];
  const v = call.variables;
  if (typeof v['accountId'] === 'number') out.push(v['accountId']);
  if (Array.isArray(v['accounts'])) out.push(...(v['accounts'] as number[]));
  if (typeof v['query'] === 'string') {
    const m = /accountId IN \(([^)]*)\)/.exec(v['query']);
    if (m?.[1]) out.push(...m[1].split(',').map((s) => Number(s.trim().replace(/'/g, ''))));
  }
  if (typeof v['guid'] === 'string') out.push(decodeEntityGuid(v['guid']).accountId);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The world and the app
// ---------------------------------------------------------------------------------------------------------------

export interface Captured {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly requestId: string | null;
}

export interface Harness {
  readonly world: World;
  readonly nerdGraph: HostileNerdGraph;
  readonly logLines: string[];
  /** Every response body the suite saw (the leak scan reads them). */
  readonly responses: string[];
  /** The app under test (one per harness; access cache off unless a test builds its own). */
  readonly app: { fetch(request: Request): Response | Promise<Response> };
  /** The audit recorder's hooks (compose with others via `mergeHooks`). */
  readonly recorderHooks: HttpAppHooks;
  makeApp(over?: Partial<HttpAppOptions>): { fetch(request: Request): Response | Promise<Response> };
  send(request: Request, app?: { fetch(request: Request): Response | Promise<Response> }): Promise<Captured>;
  /** A validated credential reaching `reachable` (default 1, 2, 3 and FOREIGN). */
  addCredential(opts?: {
    readonly key?: string;
    readonly reachable?: readonly number[];
    readonly ownerUserId?: string | null;
  }): Promise<string>;
  addUser(email: string): Promise<string>;
  addProject(
    slug: string,
    opts?: {
      readonly credentialId?: string;
      readonly allowed?: readonly number[];
      readonly enabledTools?: readonly string[] | null;
      readonly limits?: StoredLimits;
    },
  ): Promise<string>;
  addGrant(
    projectId: string,
    opts?: {
      readonly userId?: string | null;
      readonly tools?: readonly string[] | null;
      readonly accountIds?: readonly number[] | null;
      readonly credentialId?: string | null;
      readonly limits?: StoredLimits;
    },
  ): Promise<string>;
  /** Issue a token; `issuedAt`/`ttl` place its expiry. */
  addToken(grantId: string, opts?: { readonly ttl?: number; readonly issuedAt?: number }): Promise<Token>;
  /** A fresh project with its own grant and token on the main credential (a working baseline to break). */
  addTenant(
    slug: string,
  ): Promise<{ readonly projectId: string; readonly grantId: string; readonly token: Token }>;
  auditRows(): Promise<readonly AuditRecord[]>;
  /** Wait for the `auth.denied` row of a request. */
  deniedRow(requestId: string): Promise<AuditRecord>;
  /** Every secret that must never appear in a response, a log line or an audit row. */
  secrets(): Promise<string[]>;
  /** T8: fail when any secret reached a response, a log line or the audit log. */
  scan(): Promise<void>;
}

export interface Token {
  readonly id: string;
  readonly value: string;
}

const stub = (reachable: readonly number[]) => async (): Promise<Identity> => ({
  user: { id: 7, email: 'a@example.com', name: 'A' },
  accounts: reachable.map((id) => ({ id, name: `acct ${id}` })),
});

export async function createHarness(opts: { tenants?: Record<string, string> } = {}): Promise<Harness> {
  const world = await seedWorld();
  const { storage, keyring, clock } = world;
  const nerdGraph = hostileNerdGraph(opts.tenants ?? { [NR_KEY]: 'alpha', [NR_KEY_B]: 'beta' });
  const logLines: string[] = [];
  const responses: string[] = [];
  const issued: string[] = [];
  const mainCredential = (await storage.projects.get(world.projectIds.prod))?.defaultCredentialId as string;
  const logger = createLogger({ level: 'debug', sink: (l) => logLines.push(l), now: () => clock.now() });
  const recorder = createAuditRecorder({
    storage,
    logger,
    clock,
    nrql: 'full',
    // The matrix provokes hundreds of refusals per test; the flood cap has its own tests (audit.test.ts).
    maxAuthRowsPerMinute: 1_000_000,
    getClientIp: () => '203.0.113.7',
  });

  const makeApp = (over: Partial<HttpAppOptions> = {}) =>
    createHttpApp({
      storage,
      keyring,
      clock,
      logger,
      fetch: nerdGraph.fetch,
      accessCacheTtlMs: 0,
      hooks: recorder.hooks,
      admin: {
        token: new Secret(ADMIN_TOKEN),
        storage,
        validateKey: stub([1, 2, 3]),
        audit: recorder,
      },
      ...over,
    });
  const app = makeApp();

  const harness: Harness = {
    world,
    nerdGraph,
    logLines,
    responses,
    app,
    makeApp,
    recorderHooks: recorder.hooks,
    async send(request, target = app) {
      const res = await target.fetch(request);
      const text = await res.text();
      responses.push(text);
      return { status: res.status, headers: res.headers, text, requestId: res.headers.get('x-request-id') };
    },
    async addCredential(o = {}) {
      const cred = await createCredential(
        { storage, keyring, validate: stub(o.reachable ?? [1, 2, 3, FOREIGN]), clock },
        {
          label: 'extra',
          region: 'US',
          apiKey: new Secret(o.key ?? NR_KEY),
          ...(o.ownerUserId === undefined ? {} : { ownerUserId: o.ownerUserId }),
        },
      );
      return cred.id;
    },
    async addUser(email) {
      const id = newId('usr');
      await storage.users.create({ id, email, role: 'member' });
      return id;
    },
    async addProject(slug, o = {}) {
      const id = newId('prj');
      const allowed = o.allowed ?? [1, 2];
      await storage.projects.create({
        id,
        slug,
        defaultAccountId: allowed[0] ?? 1,
        allowedAccountIds: allowed,
        defaultCredentialId: o.credentialId ?? mainCredential,
        enabledTools: o.enabledTools ?? null,
        limits: o.limits ?? {},
      });
      return id;
    },
    async addGrant(projectId, o = {}) {
      const id = newId('grt');
      await storage.grants.create({
        id,
        projectId,
        userId: o.userId === undefined ? 'usr_a' : o.userId,
        label: o.userId === null ? 'service' : null,
        credentialId: o.credentialId ?? null,
        tools: o.tools ?? null,
        accountIds: o.accountIds ?? null,
        limits: o.limits ?? {},
      });
      return id;
    },
    async addToken(grantId, o = {}) {
      const { token, record } = await issueAccessToken(
        storage,
        { grantId, label: 'device', ...(o.ttl === undefined ? {} : { ttl: o.ttl }) },
        o.issuedAt ?? T0,
      );
      issued.push(token.reveal());
      return { id: record.id, value: token.reveal() };
    },
    async addTenant(slug) {
      const projectId = await harness.addProject(slug);
      const grantId = await harness.addGrant(projectId);
      return { projectId, grantId, token: await harness.addToken(grantId) };
    },
    async auditRows() {
      return storage.auditLog.list({ limit: 100_000 });
    },
    async deniedRow(requestId) {
      let row: AuditRecord | undefined;
      await vi.waitFor(async () => {
        row = (await storage.auditLog.list({ kind: 'auth', action: 'auth.denied', limit: 100_000 })).find(
          (r) => r.requestId === requestId,
        );
        if (row === undefined) throw new Error(`no auth.denied audit row for request ${requestId}`);
      });
      return row as AuditRecord;
    },
    async secrets() {
      const hashes = (await storage.accessTokens.list()).map((t) => t.tokenHash);
      return [NR_KEY, NR_KEY_B, ADMIN_TOKEN, ...Object.values(world.tokens), ...issued, ...hashes];
    },
    async scan() {
      const audit = JSON.stringify(await harness.auditRows());
      const dump = `${responses.join('\n')}\n${logLines.join('\n')}\n${audit}`;
      for (const secret of await harness.secrets()) {
        if (dump.includes(secret)) throw new Error(`a secret (${secret.slice(0, 8)}…) leaked`);
      }
      if (/"(tokenHash|token_hash|ciphertext|iv)"\s*:/.test(dump)) {
        throw new Error('key material or a token hash leaked');
      }
    },
  };
  return harness;
}
