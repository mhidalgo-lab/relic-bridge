// SPDX-License-Identifier: Apache-2.0
// A seeded world for the HTTP tests: two projects sharing one key, a limited service grant, a raw-NRQL-off project.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createCredential,
  createGrant,
  createProject,
  generateMasterKey,
  issueAccessToken,
  Keyring,
} from '@relic-bridge/auth';
import { type Clock, createBuiltinTools, type FetchLike, type Identity, Secret } from '@relic-bridge/core';
import { createMemoryStorage, type Storage } from '@relic-bridge/storage';
import type { Hono } from 'hono';

/** Shaped like a User key so redaction is exercised; obviously fake. */
export const NR_KEY = 'NRAK-HTTPAPPTESTKEY0123456789ABC';
export const CATALOG: readonly string[] = createBuiltinTools().map((t) => t.name);
/**
 * A random admin token as `admin-token generate` would make one (P3-13 refuses predictable tokens at boot). Random per
 * run so no high-entropy literal sits in the repository.
 */
export function randomAdminToken(prefix = 'adm-'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const T0 = 1_800_000_000_000;

export class ManualClock implements Clock {
  constructor(public t: number = T0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface World {
  readonly storage: Storage;
  readonly keyring: Keyring;
  readonly clock: ManualClock;
  readonly tokens: {
    /** Full grant on `prod`. */
    readonly prod: string;
    /** Service grant on `prod` limited to whoami + list_accounts. */
    readonly limited: string;
    /** Grant on `eu` (same key). */
    readonly eu: string;
    /** Grant on `noraw` (project with rawNrql off). */
    readonly noraw: string;
    /** Grant on `prod` whose token expires 10 s after T0. */
    readonly shortLived: string;
  };
  readonly tokenIds: { readonly prod: string; readonly shortLived: string };
  readonly projectIds: { readonly prod: string; readonly eu: string };
  readonly grantIds: { readonly prod: string };
}

/** `parts` lets a host bring its own keyring (the Worker's master key) and a clock that also moves the system time. */
export async function seedWorld(
  storage: Storage = createMemoryStorage({ now: () => T0 }),
  parts: { readonly keyring?: Keyring; readonly clock?: ManualClock } = {},
): Promise<World> {
  const clock = parts.clock ?? new ManualClock();
  const keyring = parts.keyring ?? (await Keyring.create({ current: generateMasterKey(1) }));
  await storage.users.create({ id: 'usr_a', email: 'a@example.com', role: 'owner' });
  const validate = async (): Promise<Identity> => ({
    user: { id: 7, email: 'a@example.com', name: 'A' },
    accounts: [1, 2].map((id) => ({ id, name: `acct ${id}` })),
  });
  const cred = await createCredential(
    { storage, keyring, validate, clock },
    { label: 'main', region: 'US', apiKey: new Secret(NR_KEY), ownerUserId: 'usr_a' },
  );
  const project = (slug: string, limits = {}) =>
    createProject(
      storage,
      { slug, defaultAccountId: 1, allowedAccountIds: [1, 2], defaultCredentialId: cred.id, limits },
      CATALOG,
    );
  const prod = await project('prod');
  const eu = await project('eu');
  const noraw = await project('noraw', { rawNrql: false });
  const grant = async (projectId: string, extra: Record<string, unknown> = {}) =>
    (await createGrant(storage, { projectId, userId: 'usr_a', ...extra }, CATALOG, T0)).grant;
  const gProd = await grant(prod.id);
  const gLimited = (
    await createGrant(
      storage,
      { projectId: prod.id, label: 'bot', tools: ['whoami', 'list_accounts'] },
      CATALOG,
      T0,
    )
  ).grant;
  const gEu = await grant(eu.id);
  const gNoraw = await grant(noraw.id);
  const issue = (grantId: string, ttl?: number) =>
    issueAccessToken(storage, { grantId, label: 'laptop', ...(ttl === undefined ? {} : { ttl }) }, T0);
  const tProd = await issue(gProd.id);
  const tShort = await issue(gProd.id, 10_000);
  return {
    storage,
    keyring,
    clock,
    tokens: {
      prod: tProd.token.reveal(),
      limited: (await issue(gLimited.id)).token.reveal(),
      eu: (await issue(gEu.id)).token.reveal(),
      noraw: (await issue(gNoraw.id)).token.reveal(),
      shortLived: tShort.token.reveal(),
    },
    tokenIds: { prod: tProd.record.id, shortLived: tShort.record.id },
    projectIds: { prod: prod.id, eu: eu.id },
    grantIds: { prod: gProd.id },
  };
}

export interface NerdGraphCall {
  readonly apiKey: string | null;
  readonly query: string;
}

/** A NerdGraph stand-in answering every query with the identity of the fake user (enough for whoami). */
export function mockNerdGraph(): { fetch: FetchLike; calls: NerdGraphCall[] } {
  const calls: NerdGraphCall[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body)) as { query: string };
    calls.push({ apiKey: headers.get('api-key'), query: body.query });
    return new Response(
      JSON.stringify({
        data: {
          actor: {
            user: { id: 7, name: 'A', email: 'a@example.com' },
            accounts: [
              { id: 1, name: 'one' },
              { id: 2, name: 'two' },
            ],
          },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, calls };
}

export type Era = 'legacy' | 'modern';

/** An SDK client whose transport calls the app in-process (no socket). */
export async function connect(
  app: Hono<never> | { fetch: (req: Request) => Response | Promise<Response> },
  slug: string,
  token: string,
  era: Era,
  /** What the client declares under `capabilities.extensions` (e.g. MCP Apps, P7-16). */
  extensions?: Record<string, Record<string, string[]>>,
  /** Other capabilities the client declares (e.g. `elicitation`, P7-20). */
  capabilities?: Record<string, unknown>,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost/p/${slug}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
  });
  const client = new Client(
    { name: 'http-test', version: '0' },
    {
      ...(extensions === undefined && capabilities === undefined
        ? {}
        : { capabilities: { ...capabilities, ...(extensions === undefined ? {} : { extensions }) } }),
      versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } },
    },
  );
  await client.connect(transport);
  return client;
}

/** A setup link split the way a browser sees it (P8-86): the code is in the fragment, never in the request. */
export function parseSetupLink(url: string): { path: string; code: string; provider: string | null } {
  const u = new URL(url);
  const m = /^#setup=(rb_setup_[0-9a-f]{64})$/.exec(u.hash);
  if (m === null || u.searchParams.has('setup')) throw new Error('not a fragment setup link');
  return { path: `${u.pathname}${u.search}`, code: m[1] as string, provider: u.searchParams.get('provider') };
}

/**
 * What the setup page posts (`admin.js` fills the form from the fragment): a same-origin, form-encoded body with the
 * code. `headers` overrides the browser's fetch metadata (`origin: ''` drops the header).
 */
export function setupPostRequest(
  publicUrl: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Request {
  const h = new Headers({
    origin: new URL(publicUrl).origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/x-www-form-urlencoded',
  });
  for (const [k, v] of Object.entries(headers)) {
    if (v === '') h.delete(k);
    else h.set(k, v);
  }
  return new Request(`${new URL(publicUrl).origin}/auth/setup`, {
    method: 'POST',
    headers: h,
    body: new URLSearchParams(form).toString(),
  });
}

/** The `name=value` of the setup cookie a response sets, or null. */
export function setupCookieOf(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => /^(__Host-)?rb_setup=[0-9a-f]{64};/.test(c));
  return line === undefined ? null : (line.split(';')[0] as string);
}
