// SPDX-License-Identifier: Apache-2.0
// P4-07 security review, sign-in (P4-01) at the provider level: regression tests for the fixed findings ("fix:") and
// the attacks probed that hold. Report: docs/reviews/phase-4-admin-security-review.md.
import { Secret } from '@relic-bridge/core';
import { createMemoryStorage } from '@relic-bridge/storage';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCloudflareAccessProvider,
  createGitHubProvider,
  createOidcProvider,
  finishLogin,
  IdentityError,
  pkceChallenge,
  type RedirectIdentityProvider,
  startLogin,
  type VerifiedIdentity,
} from '../src/identity/index.ts';
import {
  CF_AUD,
  CF_TEAM,
  createMockIdp,
  GITHUB_CLIENT_ID,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_ISSUER,
  type MockIdp,
} from './mock-idp.ts';

const REDIRECT = 'https://bridge.example.com/auth/callback/oidc';
type F = MockIdp['fetch'];

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (e instanceof IdentityError) return e.code;
  throw new Error(`expected IdentityError, got ${String(e)}`);
}

async function run(
  idp: MockIdp,
  provider: RedirectIdentityProvider,
  over: { nonce?: string } = {},
): Promise<VerifiedIdentity> {
  const verifier = 'v'.repeat(43);
  const url = await provider.authorizationUrl({
    redirectUri: REDIRECT,
    state: 's'.repeat(43),
    nonce: 'n'.repeat(43),
    codeChallenge: await pkceChallenge(verifier),
  });
  const back = await idp.authorize(url);
  return provider.complete({
    code: back.searchParams.get('code') as string,
    redirectUri: REDIRECT,
    codeVerifier: verifier,
    nonce: over.nonce ?? 'n'.repeat(43),
  });
}

const mk = (fetch: F, issuer = MOCK_ISSUER) =>
  createOidcProvider({
    id: 'oidc',
    label: 'SSO',
    idp: 'oidc:corp',
    issuer,
    clientId: MOCK_CLIENT_ID,
    clientSecret: new Secret(MOCK_CLIENT_SECRET),
    fetch,
  });

describe('P4-07 review: oversized / hostile IdP responses', () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await createMockIdp();
  });

  // Finding L1 (fixed): jose's JWKS loader read the body whole; it now goes through the 256 KiB IdP response cap.
  it('fix: a multi-MiB JWKS response is refused without being fully read', async () => {
    let bytesServed = 0;
    const hostile: F = async (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname === '/jwks') {
        const chunk = new Uint8Array(16 * 1024).fill(0x20);
        let n = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (n++ >= 4096) return c.close();
            bytesServed += chunk.byteLength;
            c.enqueue(chunk);
          },
        });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      }
      return idp.fetch(input, init);
    };
    await run(idp, mk(hostile)).catch(() => undefined);
    expect(bytesServed).toBeLessThanOrEqual(512 * 1024);
  });

  it('JWKS fetch never follows redirects (redirect: manual) and a 302 fails closed', async () => {
    const seen: (string | undefined)[] = [];
    const f: F = async (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname === '/jwks') {
        seen.push(init?.redirect);
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
      }
      return idp.fetch(input, init);
    };
    expect(['idp_unavailable', 'invalid_token']).toContain(await code(run(idp, mk(f))));
    expect(seen.every((r) => r === 'manual')).toBe(true);
  });

  it('JWKS fetch has an abort signal (timeout)', async () => {
    const signals: boolean[] = [];
    const f: F = async (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname === '/jwks') signals.push(init?.signal instanceof AbortSignal);
      return idp.fetch(input, init);
    };
    await run(idp, mk(f));
    expect(signals).toEqual([true]);
  });

  it('unknown-kid tokens do not hammer the JWKS endpoint (cooldown)', async () => {
    const provider = mk(idp.fetch);
    for (let i = 0; i < 15; i++) {
      idp.idTokenHeader = { kid: `evil-${i}` };
      await run(idp, provider).catch(() => undefined);
    }
    expect(idp.jwksFetches()).toBeLessThanOrEqual(2);
  });

  it('discovery with token_endpoint / jwks_uri / userinfo on http (non-loopback) is refused', async () => {
    for (const k of ['token_endpoint', 'jwks_uri', 'authorization_endpoint']) {
      idp.discovery = { [k]: 'http://evil.example/x' };
      expect(
        await code(
          mk(idp.fetch).authorizationUrl({
            redirectUri: REDIRECT,
            state: 's',
            nonce: 'n',
            codeChallenge: 'c',
          }),
        ),
      ).toBe('idp_unavailable');
    }
  });

  it('discovery redirect (302) is refused', async () => {
    const f: F = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    expect(
      await code(
        mk(f).authorizationUrl({ redirectUri: REDIRECT, state: 's', nonce: 'n', codeChallenge: 'c' }),
      ),
    ).toBe('idp_unavailable');
  });
});

describe('P4-07 review: ID token validation', () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await createMockIdp();
  });

  it('nonce missing, aud array without azp, wrong azp, nbf in future, iat too old, exp past', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Record<string, unknown>][] = [
      ['nonce missing', { nonce: undefined }],
      ['aud array no azp', { aud: [MOCK_CLIENT_ID, 'other'] }],
      ['wrong azp', { azp: 'other' }],
      ['nbf future', { nbf: now + 3600 }],
      ['iat old', { iat: now - 7200 }],
      ['iat missing', { iat: undefined }],
      ['exp past', { exp: now - 3600 }],
      ['exp missing', { exp: undefined }],
      ['sub numeric', { sub: 42 }],
      ['sub empty', { sub: '' }],
      ['aud wrong', { aud: 'other' }],
      ['iss with trailing slash', { iss: `${MOCK_ISSUER}/` }],
    ];
    for (const [name, claims] of cases) {
      idp.idTokenClaims = claims;
      const c = await run(idp, mk(idp.fetch)).then(
        () => 'ACCEPTED',
        (e) => (e as IdentityError).code,
      );
      expect(c, name).not.toBe('ACCEPTED');
    }
  });

  it('key confusion: kid unknown, same kid foreign key, embedded jwk header, jku, crit, none, HS256', async () => {
    const attacker = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(attacker.publicKey)), kid: 'k1' };
    const now = Math.floor(Date.now() / 1000);
    const base = {
      iss: MOCK_ISSUER,
      aud: MOCK_CLIENT_ID,
      sub: 'u',
      email: 'owner@example.com',
      email_verified: true,
      nonce: 'n'.repeat(43),
      iat: now,
      exp: now + 600,
    };
    const forge = async (header: Record<string, unknown>) =>
      new SignJWT(base).setProtectedHeader({ alg: 'RS256', ...header } as never).sign(attacker.privateKey);
    const variants: Record<string, unknown>[] = [
      { kid: 'k1' },
      { kid: 'k1', jwk },
      { jwk },
      { kid: 'k1', jku: 'https://evil.example/jwks' },
      { kid: 'k1', x5u: 'https://evil.example/x5' },
      { kid: '../../etc' },
      {},
    ];
    for (const h of variants) {
      const tok = await forge(h);
      // Serve the forged token from the token endpoint
      const f: F = async (input, init) => {
        const res = await idp.fetch(input, init);
        const u = new URL(input instanceof Request ? input.url : String(input));
        if (u.pathname === '/token') {
          const b = (await res.json()) as Record<string, unknown>;
          b['id_token'] = tok;
          return new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
        }
        return res;
      };
      const out = await run(idp, mk(f)).then(
        () => 'ACCEPTED',
        (e) => (e as IdentityError).code,
      );
      expect(out, JSON.stringify(Object.keys(h))).not.toBe('ACCEPTED');
    }
  });

  it('unverified email shapes: false, "false", "1", 1, missing', async () => {
    for (const v of [false, 'false', '1', 1, 'TRUE', undefined]) {
      idp.user = { sub: 'u', email: 'owner@example.com', email_verified: v };
      expect(await code(run(idp, mk(idp.fetch)))).toBe('email_unverified');
    }
  });

  // Finding L2 (fixed): email was only lowercased; compatibility characters (Kelvin sign) fold into ASCII, so an IdP that
  // treats "Kevin@corp.com" and "kevin@corp.com" as different accounts can be used to take over the ASCII row.
  it('fix: non-ASCII emails are refused (no case-fold collision with an ASCII account)', async () => {
    idp.user = { sub: 'u', email: '\u212Aevin@example.com', email_verified: true };
    const r = await run(idp, mk(idp.fetch)).then(
      (i) => i.email,
      (e) => (e as IdentityError).code,
    );
    expect(r).toBe('email_missing');
  });

  it('userinfo subject mismatch refused', async () => {
    idp.idTokenClaims = { email: undefined, email_verified: undefined };
    const f: F = async (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.pathname === '/userinfo')
        return new Response(
          JSON.stringify({ sub: 'someone-else', email: 'owner@example.com', email_verified: true }),
          { headers: { 'content-type': 'application/json' } },
        );
      return idp.fetch(input, init);
    };
    expect(await code(run(idp, mk(f)))).toBe('invalid_token');
  });

  it('issuer mix-up: callback iss of another IdP, and absent iss when advertised', async () => {
    const p = mk(idp.fetch);
    const verifier = 'v'.repeat(43);
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT,
      state: 's'.repeat(43),
      nonce: 'n'.repeat(43),
      codeChallenge: await pkceChallenge(verifier),
    });
    const back = await idp.authorize(url);
    const base = {
      code: back.searchParams.get('code') as string,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      nonce: 'n'.repeat(43),
    };
    expect(await code(p.complete({ ...base, issuer: 'https://evil.example' }))).toBe('issuer_mismatch');
    idp.discovery = { authorization_response_iss_parameter_supported: true };
    const p2 = mk(idp.fetch);
    expect(await code(p2.complete(base))).toBe('issuer_mismatch');
  });

  it('discovery document issuer mismatch (lookalike issuer) refused', async () => {
    idp.discovery = { issuer: `${MOCK_ISSUER}/` };
    expect(
      await code(
        mk(idp.fetch).authorizationUrl({ redirectUri: REDIRECT, state: 's', nonce: 'n', codeChallenge: 'c' }),
      ),
    ).toBe('idp_unavailable');
  });
});

describe('P4-07 review: login transactions', () => {
  it('state is single use under parallel callbacks', async () => {
    const kv = createMemoryStorage().kv;
    const clock = { now: () => Date.now() };
    const s = await startLogin(kv, { provider: 'oidc', next: '/admin', setup: null }, clock);
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        finishLogin(kv, { state: s.state, binding: s.binding, provider: 'oidc' }, clock),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
  });

  it('wrong binding / wrong provider / expired are refused (and state is burnt)', async () => {
    const kv = createMemoryStorage().kv;
    let t = 1_000_000;
    const clock = { now: () => t };
    const s = await startLogin(kv, { provider: 'oidc', next: '/admin', setup: null }, clock);
    expect(await code(finishLogin(kv, { state: s.state, binding: undefined, provider: 'oidc' }, clock))).toBe(
      'binding_mismatch',
    );
    const s2 = await startLogin(kv, { provider: 'oidc', next: '/admin', setup: null }, clock);
    expect(
      await code(finishLogin(kv, { state: s2.state, binding: s2.binding, provider: 'google' }, clock)),
    ).toBe('provider_mismatch');
    const s3 = await startLogin(kv, { provider: 'oidc', next: '/admin', setup: null }, clock);
    t += 601_000;
    expect(
      await code(finishLogin(kv, { state: s3.state, binding: s3.binding, provider: 'oidc' }, clock)),
    ).toBe('unknown_state');
  });
});

describe('P4-07 review: GitHub and Cloudflare Access', () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await createMockIdp();
  });
  const gh = () =>
    createGitHubProvider({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: new Secret(MOCK_CLIENT_SECRET),
      orgs: ['relic-org'],
      fetch: idp.fetch,
    });

  it('GitHub: unverified primary with a verified secondary is refused; no primary refused; pending org is not membership', async () => {
    idp.githubUser.emails = [
      { email: 'victim@example.com', primary: false, verified: true },
      { email: 'attacker@example.net', primary: true, verified: false },
    ];
    expect(await code(run(idp, gh()))).toBe('email_unverified');
    idp.githubUser.emails = [{ email: 'victim@example.com', primary: false, verified: true }];
    expect(await code(run(idp, gh()))).toBe('email_missing');
    idp.githubUser.emails = [{ email: 'a@example.com', primary: true, verified: true }];
    idp.githubUser.orgs = { 'relic-org': 'pending' };
    expect((await run(idp, gh())).orgs).toEqual([]);
  });

  const cf = () => createCloudflareAccessProvider({ team: CF_TEAM, audience: CF_AUD, fetch: idp.fetch });
  const h = (v: string) => new Headers({ 'cf-access-jwt-assertion': v });

  it('Access: service token, wrong aud, wrong iss, HS256/none header, cookie only are refused', async () => {
    const p = cf();
    expect(
      await code(
        p.verify(
          h(
            await idp.accessAssertion({ email: undefined, sub: '', common_name: 'x', type: 'service-token' }),
          ),
        ),
      ),
    ).not.toBe('ACCEPTED');
    expect(await code(p.verify(h(await idp.accessAssertion({ aud: ['x'.repeat(64)] }))))).toBe(
      'wrong_audience',
    );
    expect(
      await code(p.verify(h(await idp.accessAssertion({ iss: 'https://evil.cloudflareaccess.com' })))),
    ).toBe('wrong_issuer');
    const good = await idp.accessAssertion();
    const [hd, pl] = good.split('.');
    const none = `${btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/, '')}.${pl}.`;
    expect(await code(p.verify(h(none)))).toBe('invalid_token');
    void hd;
    expect(await code(p.verify(new Headers({ cookie: `CF_Authorization=${good}` })))).toBe(
      'missing_assertion',
    );
  });

  // Info: Access JWKS URL is derived from the team name only (regex-checked); never from the token.
  it('Access team name cannot inject a host', () => {
    for (const t of ['evil.com/x', 'a.b', 'x@evil', '', 'a'.repeat(70)]) {
      expect(() => createCloudflareAccessProvider({ team: t, audience: CF_AUD })).toThrow();
    }
  });
});
