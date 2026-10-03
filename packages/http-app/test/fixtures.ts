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

export async function seedWorld(storage: Storage = createMemoryStorage({ now: () => T0 })): Promise<World> {
  const clock = new ManualClock();
  const keyring = await Keyring.create({ current: generateMasterKey(1) });
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
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost/p/${slug}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url, init) => Promise.resolve(app.fetch(new Request(url, init))),
  });
  const client = new Client(
    { name: 'http-test', version: '0' },
    { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  return client;
}
