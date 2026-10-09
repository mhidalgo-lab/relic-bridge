// SPDX-License-Identifier: Apache-2.0
// Shared harness of the authorization and isolation suite (P2-12): a seeded world with helpers to add the odd states
// (revoked, disabled, unvalidated, …), the app under test with the admin API and the audit recorder, a hostile
// NerdGraph stand-in and a leak scan. Web-standard only (no `node:*`): P3-06 runs the same suite under the Workers pool
// by swapping `makeApp` for the Worker's fetch.
import {
  createCloudflareAccessProvider,
  createCredential,
  createGitHubProvider,
  createSession,
  DEFAULT_SESSION_TIMEOUTS,
  issueAccessToken,
  type Keyring,
} from '@relic-bridge/auth';
import { createLogger, decodeEntityGuid, type FetchLike, type Identity, Secret } from '@relic-bridge/core';
import {
  type AuditRecord,
  newId,
  type Storage,
  type StoredLimits,
  type UserRole,
} from '@relic-bridge/storage';
import { vi } from 'vitest';
import { CF_AUD, CF_TEAM, GITHUB_CLIENT_ID, MOCK_CLIENT_SECRET } from '../../../auth/test/mock-idp.ts';
import {
  createAuditRecorder,
  createHttpApp,
  type HttpAppHooks,
  type HttpAppOptions,
  type IdentityOptions,
} from '../../src/index.ts';
import { type ManualClock, NR_KEY, randomAdminToken, seedWorld, T0, type World } from '../fixtures.ts';

/** Bootstrap admin token of the app under test (≥ 32 printable characters). */
export const ADMIN_TOKEN: string = randomAdminToken();
/** An account every test key can reach at New Relic but no project allows. */
export const FOREIGN = 999;
/** Marks every piece of foreign data the hostile NerdGraph returns; must never reach a client. */
export const LEAK = 'FOREIGN-LEAK';
/** A second key (another tenant), shaped like a User key. */
export const NR_KEY_B = 'NRAK-TENANTBTESTKEY0123456789XYZ';
/** The key the admin matrix creates and rotates credentials with (a live validation must accept it). */
export const NR_KEY_ADMIN = 'NRAK-MATRIXTESTKEY0123456789ABCDE';

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

/** An entity id that this NerdGraph answers honestly (the entity really is in the GUID's account): a success path. */
export const HONEST_ID = 'honest';
const isHonest = (guid: unknown): boolean => {
  try {
    return decodeEntityGuid(String(guid)).domainId === HONEST_ID;
  } catch {
    return false;
  }
};

const vertex = (account: number, name: string, guid = guidOf(account, name)) => ({
  guid,
  accountId: account,
  entity: { name, domain: 'APM', type: 'APPLICATION', alertSeverity: 'WARNING', reporting: true },
});

const alertPolicy = (account: number, name: string) => ({
  id: '8000026',
  name,
  accountId: account,
  incidentPreference: 'PER_CONDITION',
  entityGuid: guidOf(account, '8000026', 'AIOPS', 'POLICY'),
});

const alertCondition = (account: number, name: string) => ({
  id: '9000001',
  name,
  policyId: '8000026',
  entityGuid: guidOf(account, '9000001', 'AIOPS', 'CONDITION'),
  enabled: true,
  type: 'STATIC',
  nrql: { query: 'FROM TransactionError SELECT count(*)', dataAccountId: account },
  terms: [
    {
      priority: 'CRITICAL',
      operator: 'ABOVE',
      threshold: 5,
      thresholdDuration: 300,
      thresholdOccurrences: 'ALL',
    },
  ],
});

const aiIssue = (accountIds: number[], title: string, guid: string) => ({
  issueId: `issue-${title}`,
  title: [title],
  description: [],
  state: 'ACTIVATED',
  priority: 'HIGH',
  createdAt: 1790338648000,
  updatedAt: 1790338700000,
  accountIds,
  entityGuids: [guid],
  entityNames: [title],
});

const aiIncident = (accountIds: number[], title: string, guid: string) => ({
  incidentId: `inc-${title}`,
  title,
  description: [],
  state: 'CREATED',
  priority: 'HIGH',
  createdAt: 1790338648000,
  updatedAt: 1790338700000,
  timestamp: 1790338648000,
  accountIds: accountIds.join(','),
  entityGuids: guid,
  entityNames: title,
});

const errorGroup = (guid: string | null, name: string) => ({
  id: `eg-${name}`,
  name,
  message: 'boom',
  state: 'UNRESOLVED',
  issueType: 'ERROR',
  entityGuid: guid,
  firstSeenAt: 1790338648000,
  lastSeenAt: 1790338700000,
  occurrences: { totalCount: 3, firstSeenAt: 1790338648000, lastSeenAt: 1790338700000 },
});

const changeEvent = (guid: string | null, id: string) => ({
  changeTrackingId: id,
  category: 'DEPLOYMENT',
  type: 'BASIC',
  categoryAndType: 'DEPLOYMENT__BASIC',
  timestamp: 1790338700000,
  description: 'rollout',
  shortDescription: 'deploy',
  user: 'ci',
  entity: guid === null ? null : { guid, name: id, accountId: 1, domain: 'APM', type: 'APPLICATION' },
  version: '1.0',
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
      const op = /(?:query|mutation) (Rb\w+)/.exec(body.query)?.[1] ?? 'unknown';
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
          // An async query naming SLOW is still running: a handle (or an MCP task, P7-13) until one progress poll.
          if (op === 'RbNrql' && variables['async'] === true && nrql.includes('SLOW')) {
            return ok({
              actor: {
                account: {
                  nrql: {
                    ...nrqlContainer([]),
                    results: null,
                    queryProgress: {
                      queryId: `slow-${label}`,
                      completed: false,
                      retryAfter: 1,
                      resultExpiration: null,
                    },
                  },
                },
              },
            });
          }
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
        case 'RbSyntheticMonitors':
          return ok({
            actor: {
              entitySearch: {
                count: 4,
                results: {
                  nextCursor: null,
                  entities: [
                    {
                      ...entity(1, `${label}-monitor-1`),
                      domain: 'SYNTH',
                      type: 'MONITOR',
                      monitorType: 'SIMPLE',
                    },
                    // Another allowed account: not the one requested.
                    { ...entity(2, `${label}-monitor-2`), domain: 'SYNTH', type: 'MONITOR' },
                    { ...entity(FOREIGN, `${LEAK}-monitor`), domain: 'SYNTH', type: 'MONITOR' },
                    // Reported in the requested account, but the GUID names the foreign one.
                    {
                      ...entity(1, `${LEAK}-forged`, guidOf(FOREIGN, 'forged')),
                      domain: 'SYNTH',
                      type: 'MONITOR',
                    },
                  ],
                },
              },
            },
          });
        case 'RbDashboards':
          return ok({
            actor: {
              entitySearch: {
                count: 3,
                results: {
                  nextCursor: null,
                  entities: [
                    { ...entity(1, `${label}-dash-1`), domain: 'VIZ', type: 'DASHBOARD' },
                    { ...entity(FOREIGN, `${LEAK}-dash`), domain: 'VIZ', type: 'DASHBOARD' },
                    // Reported in the requested account, but the GUID names the foreign one.
                    {
                      ...entity(1, `${LEAK}-forged`, guidOf(FOREIGN, 'forged')),
                      domain: 'VIZ',
                      type: 'DASHBOARD',
                    },
                  ],
                },
              },
            },
          });
        // A dashboard in the foreign account behind an allowed account's GUID.
        case 'RbDashboard':
          if (isHonest(variables['guid'])) {
            return ok({
              actor: {
                entity: {
                  ...entity(guidAccount(), `${label}-dashboard`, String(variables['guid'])),
                  domain: 'VIZ',
                  type: 'DASHBOARD',
                  pages: [],
                },
              },
            });
          }
          return ok({
            actor: {
              entity: {
                ...entity(FOREIGN, `${LEAK}-dashboard`, String(variables['guid'])),
                domain: 'VIZ',
                type: 'DASHBOARD',
                pages: [],
              },
            },
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
                    {
                      type: 'CALLS',
                      source: self,
                      target: vertex(
                        2,
                        `${label}-rel`,
                        isHonest(variables['guid']) ? guidOf(2, HONEST_ID) : undefined,
                      ),
                    },
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
        case 'RbAlertPolicies': {
          const account = Number(variables['accountId']);
          return ok({
            actor: {
              account: {
                alerts: {
                  policiesSearch: {
                    nextCursor: null,
                    totalCount: 3,
                    policies: [
                      alertPolicy(account, `${label}-policy`),
                      alertPolicy(FOREIGN, `${LEAK}-policy`),
                      // Reported in the requested account, but the GUID names the foreign one.
                      {
                        ...alertPolicy(account, `${LEAK}-policy-forged`),
                        entityGuid: guidOf(FOREIGN, 'p', 'AIOPS', 'POLICY'),
                      },
                    ],
                  },
                },
              },
            },
          });
        }
        case 'RbErrorGroups': {
          const filter = variables['filter'] as { accountIds: number[] };
          const account = Number(filter.accountIds[0]);
          return ok({
            actor: {
              errorsInbox: {
                errorGroups: {
                  nextCursor: null,
                  totalCount: 4,
                  results: [
                    errorGroup(guidOf(account), `${label}-error`),
                    errorGroup(guidOf(FOREIGN), `${LEAK}-error`),
                    errorGroup(null, `${LEAK}-error-noguid`),
                    errorGroup('not-a-guid', `${LEAK}-error-badguid`),
                  ],
                },
              },
            },
          });
        }
        case 'RbChangeEvents': {
          const filter = variables['filter'] as { accountIds: number[] };
          const account = Number(filter.accountIds[0]);
          return ok({
            actor: {
              changeTracking: {
                changeTrackingSearch: {
                  changeEvents: [
                    changeEvent(guidOf(account), `${label}-change`),
                    changeEvent(guidOf(FOREIGN), `${LEAK}-change`),
                    changeEvent(null, `${LEAK}-change-noentity`),
                    changeEvent('not-a-guid', `${LEAK}-change-badguid`),
                  ],
                },
              },
            },
          });
        }
        case 'RbAiIssues': {
          const account = Number(variables['accountId']);
          return ok({
            actor: {
              account: {
                aiIssues: {
                  issues: {
                    nextCursor: null,
                    issues: [
                      aiIssue([account], `${label}-issue`, guidOf(account)),
                      aiIssue([FOREIGN], `${LEAK}-issue`, guidOf(FOREIGN)),
                      // Names the requested account too, but also a foreign one.
                      aiIssue([account, FOREIGN], `${LEAK}-issue-shared`, guidOf(account)),
                      // Reported in the requested account, but the entity GUID names the foreign one.
                      aiIssue([account], `${LEAK}-issue-forged`, guidOf(FOREIGN)),
                    ],
                  },
                },
              },
            },
          });
        }
        case 'RbAiIncidents': {
          const account = Number(variables['accountId']);
          return ok({
            actor: {
              account: {
                aiIssues: {
                  incidents: {
                    nextCursor: null,
                    incidents: [
                      aiIncident([account], `${label}-incident`, guidOf(account)),
                      aiIncident([FOREIGN], `${LEAK}-incident`, guidOf(FOREIGN)),
                      aiIncident([account, FOREIGN], `${LEAK}-incident-shared`, guidOf(account)),
                    ],
                  },
                },
              },
            },
          });
        }
        case 'RbAlertConditions': {
          const account = Number(variables['accountId']);
          return ok({
            actor: {
              account: {
                alerts: {
                  nrqlConditionsSearch: {
                    nextCursor: null,
                    totalCount: 2,
                    nrqlConditions: [
                      alertCondition(account, `${label}-condition`),
                      alertCondition(FOREIGN, `${LEAK}-condition`),
                    ],
                  },
                },
              },
            },
          });
        }
        // A single entity in the foreign account behind an allowed account's GUID.
        case 'RbEntity':
        case 'RbGoldenMetrics':
          if (isHonest(variables['guid'])) {
            return ok({
              actor: { entity: entity(guidAccount(), `${label}-honest`, String(variables['guid'])) },
            });
          }
          return ok({ actor: { entity: entity(FOREIGN, `${LEAK}-entity`, String(variables['guid'])) } });
        case 'RbEntityDeployments':
          if (isHonest(variables['guid'])) {
            return ok({
              actor: {
                entity: {
                  ...entity(guidAccount(), `${label}-honest`, String(variables['guid'])),
                  deploymentSearch: {
                    results: [{ deploymentId: 'd-1', version: '9', timestamp: 1790338700000 }],
                  },
                },
              },
            });
          }
          return ok({
            actor: {
              entity: {
                ...entity(FOREIGN, `${LEAK}-entity`, String(variables['guid'])),
                deploymentSearch: {
                  results: [{ deploymentId: `${LEAK}-d`, version: '9', timestamp: 1790338700000 }],
                },
              },
            },
          });
        // Write tools (P7-09): mutations answer as New Relic documents them (no real call is ever made).
        case 'RbCreateChangeEvent': {
          const query = String(
            (variables['event'] as { entitySearch?: { query?: string } }).entitySearch?.query,
          );
          const guid = /id = '([^']*)'/.exec(query)?.[1] ?? null;
          return ok({
            changeTrackingCreateEvent: {
              changeTrackingEvent: {
                changeTrackingId: 'ct-created-1',
                category: 'DEPLOYMENT',
                type: 'BASIC',
                timestamp: 1790338700000,
                entity: { guid, accountId: guid === null ? null : decodeEntityGuid(guid).accountId },
              },
              messages: [],
            },
          });
        }
        case 'RbAckIssue':
        case 'RbResolveIssue': {
          const field = op === 'RbAckIssue' ? 'aiIssuesAckIssue' : 'aiIssuesResolveIssue';
          return ok({
            [field]: {
              result: {
                accountId: variables['accountId'],
                action: op === 'RbAckIssue' ? 'ACK' : 'RESOLVE',
                issueId: variables['issueId'],
              },
              error: null,
            },
          });
        }
        // create_dashboard (P7-19): a hostile answer names a foreign-looking dashboard with a leaky name; the tool must
        // neither echo New Relic's name nor trust what it says.
        case 'RbCreateDashboard': {
          const account = Number(variables['accountId']);
          return ok({
            dashboardCreate: {
              entityResult: {
                guid: guidOf(account, 'dash-created'),
                accountId: account,
                name: `${LEAK}-dashboard`,
                permissions: 'PRIVATE',
              },
              errors: [],
            },
          });
        }
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
  // Write tools (P7-09): the change event's entity filter names the entity by GUID.
  const search = (v['event'] as { entitySearch?: { query?: unknown } } | undefined)?.entitySearch?.query;
  if (typeof search === 'string') {
    const m = /id = '([^']*)'/.exec(search);
    if (m?.[1]) out.push(decodeEntityGuid(m[1]).accountId);
  }
  // create_dashboard (P7-19): the dashboard's account variable is above; every widget query names its own account.
  const dashboard = v['dashboard'] as
    | {
        pages?: {
          widgets?: { configuration?: Record<string, { nrqlQueries?: { accountId?: unknown }[] }> }[];
        }[];
      }
    | undefined;
  for (const page of dashboard?.pages ?? []) {
    for (const widget of page.widgets ?? []) {
      for (const config of Object.values(widget.configuration ?? {})) {
        for (const q of config.nrqlQueries ?? []) if (typeof q.accountId === 'number') out.push(q.accountId);
      }
    }
  }
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
  readonly app: AuthzApp;
  /** The audit recorder's hooks (compose with others via `mergeHooks`). */
  readonly recorderHooks: HttpAppHooks;
  /** Calls the app made to identity providers (sign-in routes, P4-01); a stand-in that answers 503. */
  readonly idpCalls: string[];
  makeApp(over?: Partial<HttpAppOptions>): { fetch(request: Request): Response | Promise<Response> };
  send(request: Request, app?: { fetch(request: Request): Response | Promise<Response> }): Promise<Captured>;
  /** A validated credential reaching `reachable` (default 1, 2, 3 and FOREIGN). */
  addCredential(opts?: {
    readonly key?: string;
    readonly reachable?: readonly number[];
    readonly ownerUserId?: string | null;
  }): Promise<string>;
  addUser(email: string, role?: UserRole): Promise<string>;
  /** A live admin session of a new user with `role` (or of `userId`). */
  addSession(opts?: { readonly role?: UserRole; readonly userId?: string }): Promise<SessionCaller>;
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

/** Origin of every host under test (`RB_PUBLIC_URL`, http loopback: the session cookie is `rb_session`). */
export const PUBLIC_ORIGIN = 'http://localhost';

/** An admin session minted straight into storage (P4-02), as sign-in would. */
export interface SessionCaller {
  readonly userId: string;
  /** Cookie value (`<userId>.<secret>`): a secret, scanned for leaks. */
  readonly value: string;
  readonly cookie: string;
  readonly csrf: string;
  /** What our own admin page sends: cookie, CSRF token, same-origin `Origin` and fetch metadata. */
  readonly headers: Readonly<Record<string, string>>;
}

const stub = (reachable: readonly number[]) => async (): Promise<Identity> => ({
  user: { id: 7, email: 'a@example.com', name: 'A' },
  accounts: reachable.map((id) => ({ id, name: `acct ${id}` })),
});

// ---------------------------------------------------------------------------------------------------------------
// Hosts: what the suite runs against. The default is the HTTP app on the in-memory storage; the Workers pool (P3-06)
// installs the Worker (`createWorker` on local D1) with `useAuthzHost` from a Vitest setup file.
// ---------------------------------------------------------------------------------------------------------------

export type AuthzApp = { fetch(request: Request): Response | Promise<Response> };

/** What a host gets to build the app under test. */
export interface HostDeps {
  readonly world: World;
  readonly nerdGraph: HostileNerdGraph;
  /** Log sink; the leak scan reads every line. */
  readonly log: (line: string) => void;
  /** Identity provider stand-in (sign-in routes): records the URL, answers 503. */
  readonly idpFetch: FetchLike;
}

/**
 * Sign-in configuration of every host (P4-01): GitHub (a redirect provider that needs no discovery, so starting a
 * login makes no IdP call) and Cloudflare Access, public URL `http://localhost`, nobody allowlisted.
 */
export const IDENTITY_ENV: Readonly<Record<string, string>> = Object.freeze({
  RB_PUBLIC_URL: 'http://localhost',
  RB_GITHUB_CLIENT_ID: GITHUB_CLIENT_ID,
  RB_GITHUB_CLIENT_SECRET: MOCK_CLIENT_SECRET,
  RB_CF_ACCESS_TEAM: CF_TEAM,
  RB_CF_ACCESS_AUD: CF_AUD,
});

/** The app under test with the admin API (token `ADMIN_TOKEN`), sign-in and the audit recorder on. */
export interface HostApp {
  makeApp(over?: Partial<HttpAppOptions>): AuthzApp;
  /** The recorder's hooks, for tests composing their own hooks (the HTTP app host only). */
  readonly recorderHooks: HttpAppHooks;
  /** Wait for background work (audit rows written through `waitUntil`). */
  settle?(): Promise<void>;
}

export interface AuthzHost {
  readonly kind: 'http-app' | 'worker';
  /** The storage, keyring and clock the world is seeded into (default: in-memory, random key, manual clock). */
  prepare?(): Promise<{ storage?: Storage; keyring?: Keyring; clock?: ManualClock }>;
  create(deps: HostDeps): HostApp;
}

export const httpAppHost: AuthzHost = {
  kind: 'http-app',
  create({ world, nerdGraph, log, idpFetch }) {
    const { storage, keyring, clock } = world;
    const logger = createLogger({ level: 'debug', sink: log, now: () => clock.now() });
    const recorder = createAuditRecorder({
      storage,
      logger,
      clock,
      nrql: 'full',
      // The matrix provokes hundreds of refusals per test; the flood cap has its own tests (audit.test.ts).
      maxAuthRowsPerMinute: 1_000_000,
      getClientIp: () => '203.0.113.7',
    });
    const identityOptions: IdentityOptions = {
      publicUrl: 'http://localhost',
      providers: [
        createGitHubProvider({
          clientId: GITHUB_CLIENT_ID,
          clientSecret: new Secret(MOCK_CLIENT_SECRET),
          fetch: idpFetch,
        }),
        createCloudflareAccessProvider({ team: CF_TEAM, audience: CF_AUD, fetch: idpFetch, clock }),
      ],
      policy: { emails: [], domains: [], githubOrgs: [], autoProvision: 'off' },
      storage,
      audit: recorder,
    };
    return {
      recorderHooks: recorder.hooks,
      makeApp: (over = {}) => {
        // Sign-in comes back to http://localhost; a test that narrows the Host allowlist elsewhere goes without it.
        const hosts = over.allowedHosts;
        const signIn = hosts === undefined || hosts === '*' || hosts.includes('localhost');
        return createHttpApp({
          storage,
          keyring,
          clock,
          logger,
          fetch: nerdGraph.fetch,
          accessCacheTtlMs: 0,
          hooks: recorder.hooks,
          // MCP Tasks (P7-13), as `serve` and the Worker keep them.
          taskStore: storage.kv,
          approvalStore: storage.kv,
          admin: {
            token: new Secret(ADMIN_TOKEN),
            storage,
            validateKey: stub([1, 2, 3]),
            audit: recorder,
          },
          ...(signIn ? { identity: identityOptions } : {}),
          ...over,
        });
      },
    };
  },
};

let host: AuthzHost = httpAppHost;

/** Run the suite against another host (call from a Vitest setup file, before the tests are collected). */
export function useAuthzHost(next: AuthzHost): void {
  host = next;
}

/** Which host runs; lets a test that needs HTTP app internals skip itself elsewhere. */
export const authzHostKind = (): AuthzHost['kind'] => host.kind;

async function seedArgs(): Promise<Parameters<typeof seedWorld>> {
  const prepared = (await host.prepare?.()) ?? {};
  return [
    prepared.storage,
    {
      ...(prepared.keyring && { keyring: prepared.keyring }),
      ...(prepared.clock && { clock: prepared.clock }),
    },
  ];
}

export async function createHarness(opts: { tenants?: Record<string, string> } = {}): Promise<Harness> {
  const world = await seedWorld(...(await seedArgs()));
  const { storage, keyring, clock } = world;
  const nerdGraph = hostileNerdGraph(
    opts.tenants ?? { [NR_KEY]: 'alpha', [NR_KEY_B]: 'beta', [NR_KEY_ADMIN]: 'gamma' },
  );
  const logLines: string[] = [];
  const responses: string[] = [];
  const issued: string[] = [];
  const sessions: string[] = [];
  const idpCalls: string[] = [];
  const idpFetch: FetchLike = async (url) => {
    idpCalls.push(String(url));
    return new Response('{"error":"unavailable"}', { status: 503 });
  };
  const mainCredential = (await storage.projects.get(world.projectIds.prod))?.defaultCredentialId as string;
  const hosted = host.create({ world, nerdGraph, log: (l) => logLines.push(l), idpFetch });
  const makeApp = hosted.makeApp;
  const app = makeApp();

  const harness: Harness = {
    world,
    nerdGraph,
    logLines,
    responses,
    app,
    makeApp,
    recorderHooks: hosted.recorderHooks,
    idpCalls,
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
    async addUser(email, role = 'member') {
      const id = newId('usr');
      await storage.users.create({ id, email, role });
      return id;
    },
    async addSession(o = {}) {
      const userId = o.userId ?? (await harness.addUser(`${newId('usr')}@example.com`, o.role ?? 'owner'));
      const issued = await createSession(
        storage.kv,
        { userId, provider: 'github', idp: 'github' },
        DEFAULT_SESSION_TIMEOUTS,
        clock,
      );
      sessions.push(issued.cookieValue);
      const cookie = `rb_session=${issued.cookieValue}`;
      return {
        userId,
        value: issued.cookieValue,
        cookie,
        csrf: issued.record.csrf,
        headers: {
          cookie,
          origin: PUBLIC_ORIGIN,
          'sec-fetch-site': 'same-origin',
          'x-csrf-token': issued.record.csrf,
        },
      };
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
      await hosted.settle?.();
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
      return [
        NR_KEY,
        NR_KEY_B,
        NR_KEY_ADMIN,
        ADMIN_TOKEN,
        ...Object.values(world.tokens),
        ...issued,
        ...sessions,
        ...hashes,
      ];
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
