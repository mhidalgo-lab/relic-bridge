// SPDX-License-Identifier: Apache-2.0
// P4-01: identity providers against a mock IdP (self-generated keys, no network).
import { Secret, systemClock } from '@relic-bridge/core';
import { createMemoryStorage, type Storage } from '@relic-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CF_ACCESS_HEADER,
  type CompleteHooks,
  consumeSetupLink,
  createCloudflareAccessProvider,
  createGitHubProvider,
  createGoogleProvider,
  createIdentityProviders,
  createOidcProvider,
  createSetupLink,
  finishLogin,
  IdentityConfigError,
  IdentityError,
  type IdentityErrorCode,
  identitySettingsFromEnv,
  LOGIN_TTL_SECONDS,
  type LoginPolicy,
  matchAllowlist,
  parsePublicUrl,
  pkceChallenge,
  type RedirectIdentityProvider,
  resolveLoginUser,
  setupCodeHash,
  setupLinkUsable,
  startLogin,
  type VerifiedIdentity,
} from '../src/identity/index.ts';
import {
  CF_AUD,
  CF_TEAM,
  createMockIdp,
  GITHUB_CLIENT_ID,
  GOOGLE_CLIENT_ID,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_ISSUER,
  type MockIdp,
} from './mock-idp.ts';

const REDIRECT = 'https://bridge.example.com/auth/callback/oidc';

async function codeOf(e: Promise<unknown>): Promise<IdentityErrorCode | string> {
  const err = await e.then(
    () => null,
    (x: unknown) => x,
  );
  if (err instanceof IdentityError) return err.code;
  throw new Error(`expected an IdentityError, got ${String(err)}`);
}

/** Run a whole redirect login against the mock and return the identity. */
async function login(
  idp: MockIdp,
  provider: RedirectIdentityProvider,
  over: { nonce?: string; verifier?: string; redirect?: string; issuer?: string | null } = {},
): Promise<VerifiedIdentity> {
  const verifier = 'v'.repeat(43);
  const nonce = 'n'.repeat(43);
  const redirectUri = over.redirect ?? REDIRECT;
  const url = await provider.authorizationUrl({
    redirectUri,
    state: 's'.repeat(43),
    nonce,
    codeChallenge: await pkceChallenge(verifier),
  });
  const back = await idp.authorize(url);
  const iss = over.issuer === undefined ? (back.searchParams.get('iss') ?? undefined) : over.issuer;
  return provider.complete({
    code: back.searchParams.get('code') as string,
    redirectUri,
    codeVerifier: over.verifier ?? verifier,
    nonce: over.nonce ?? nonce,
    ...(iss === null || iss === undefined ? {} : { issuer: iss }),
  });
}

describe('generic OIDC', () => {
  let idp: MockIdp;
  let provider: RedirectIdentityProvider;
  beforeEach(async () => {
    idp = await createMockIdp();
    provider = createOidcProvider({
      id: 'oidc',
      label: 'SSO',
      idp: 'oidc:corp',
      issuer: MOCK_ISSUER,
      clientId: MOCK_CLIENT_ID,
      clientSecret: new Secret(MOCK_CLIENT_SECRET),
      fetch: idp.fetch,
    });
  });

  it('logs in with PKCE S256, state and nonce; the email is lowercased and verified', async () => {
    const url = await provider.authorizationUrl({
      redirectUri: REDIRECT,
      state: 's'.repeat(43),
      nonce: 'n'.repeat(43),
      codeChallenge: 'c'.repeat(43),
    });
    expect(url.origin + url.pathname).toBe(`${MOCK_ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: MOCK_CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
    });
    const who = await login(idp, provider);
    expect(who).toEqual({
      idp: 'oidc:corp',
      subject: 'user-1',
      email: 'owner@example.com',
      emailVerified: true,
      displayName: 'Owner One',
    });
    // Client authentication went in the Basic header, never the URL.
    const tr = idp.tokenRequests[0];
    expect(tr?.authorization?.startsWith('Basic ')).toBe(true);
    expect(tr?.body.get('client_secret')).toBeNull();
    expect(tr?.body.get('code_verifier')).toBe('v'.repeat(43));
  });

  it('a wrong PKCE verifier is refused by the IdP', async () => {
    expect(await codeOf(login(idp, provider, { verifier: 'x'.repeat(43) }))).toBe('idp_error');
  });

  it.each([
    ['wrong audience', { aud: 'someone-else' }, 'wrong_audience'],
    ['several audiences without azp', { aud: [MOCK_CLIENT_ID, 'other'] }, 'wrong_audience'],
    ['foreign azp', { azp: 'other' }, 'wrong_audience'],
    ['wrong issuer', { iss: 'https://evil.example' }, 'wrong_issuer'],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }, 'token_expired'],
    ['issued long ago', { iat: Math.floor(Date.now() / 1000) - 3600 }, 'token_expired'],
    ['no subject', { sub: undefined }, 'invalid_token'],
    ['no nonce', { nonce: undefined }, 'nonce_mismatch'],
    ['unverified email', { email_verified: false }, 'email_unverified'],
    ['email_verified missing', { email_verified: undefined }, 'email_unverified'],
  ])('refuses an ID token with %s', async (_name, claims, code) => {
    idp.idTokenClaims = claims;
    expect(await codeOf(login(idp, provider))).toBe(code);
  });

  it('several audiences are accepted with azp = client id', async () => {
    idp.idTokenClaims = { aud: [MOCK_CLIENT_ID, 'other'], azp: MOCK_CLIENT_ID };
    expect((await login(idp, provider)).subject).toBe('user-1');
  });

  it('refuses a nonce that is not the transaction nonce (replayed ID token)', async () => {
    expect(await codeOf(login(idp, provider, { nonce: 'm'.repeat(43) }))).toBe('nonce_mismatch');
  });

  it('refuses alg none, HMAC key confusion and a signature by another key', async () => {
    idp.idTokenHeader = { alg: 'none' };
    expect(await codeOf(login(idp, provider))).toBe('invalid_token');
    idp.idTokenHeader = { alg: 'HS256' };
    expect(await codeOf(login(idp, provider))).toBe('invalid_token');
    idp.idTokenHeader = { foreign: true };
    expect(await codeOf(login(idp, provider))).toBe('invalid_token');
  });

  it('refetches the JWKS for an unknown kid (key rotation), with a cooldown', async () => {
    await login(idp, provider);
    expect(idp.jwksFetches()).toBe(1);
    await login(idp, provider);
    expect(idp.jwksFetches()).toBe(1); // cached
    await idp.rotate(true);
    // Within the 30 s cooldown after the last fetch the new kid is not looked up again: refused, not trusted.
    expect(await codeOf(login(idp, provider))).toBe('invalid_token');
  });

  it('picks up a rotated key once the cooldown passed', async () => {
    const fresh = createOidcProvider({
      id: 'oidc',
      label: 'SSO',
      idp: 'oidc:corp',
      issuer: MOCK_ISSUER,
      clientId: MOCK_CLIENT_ID,
      clientSecret: new Secret(MOCK_CLIENT_SECRET),
      fetch: idp.fetch,
    });
    await idp.rotate(); // before the first use: k2 signs, k1 and k2 published
    expect((await login(idp, fresh)).subject).toBe('user-1');
    expect(idp.jwksFetches()).toBe(1);
  });

  it('reads email from userinfo when the ID token has none (subject must match)', async () => {
    idp.idTokenClaims = { email: undefined, email_verified: undefined };
    expect((await login(idp, provider)).email).toBe('owner@example.com');
    expect(idp.calls.some((c) => c.endsWith('/userinfo'))).toBe(true);
  });

  it('RFC 9207: a foreign iss is refused; a required iss must be present', async () => {
    idp.callbackParams = { iss: 'https://evil.example' };
    expect(await codeOf(login(idp, provider))).toBe('issuer_mismatch');
    idp.callbackParams = { iss: MOCK_ISSUER };
    expect((await login(idp, provider)).subject).toBe('user-1');
    // An IdP advertising the parameter must send it.
    const strictIdp = await createMockIdp();
    strictIdp.discovery = { authorization_response_iss_parameter_supported: true };
    const strict = createOidcProvider({
      id: 'oidc',
      label: 'SSO',
      idp: 'oidc:corp',
      issuer: MOCK_ISSUER,
      clientId: MOCK_CLIENT_ID,
      clientSecret: new Secret(MOCK_CLIENT_SECRET),
      fetch: strictIdp.fetch,
    });
    expect(await codeOf(login(strictIdp, strict, { issuer: null }))).toBe('issuer_mismatch');
  });

  it.each([
    ['another issuer in the document', { issuer: 'https://evil.example' }],
    ['an http endpoint', { token_endpoint: 'http://idp.example.test/token' }],
    ['no S256', { code_challenge_methods_supported: ['plain'] }],
    ['only HMAC signatures', { id_token_signing_alg_values_supported: ['HS256'] }],
    ['no code flow', { response_types_supported: ['id_token'] }],
  ])('refuses a discovery document with %s', async (_name, doc) => {
    idp.discovery = doc;
    expect(
      await codeOf(
        provider.authorizationUrl({
          redirectUri: REDIRECT,
          state: 's'.repeat(43),
          nonce: 'n'.repeat(43),
          codeChallenge: 'c'.repeat(43),
        }),
      ),
    ).toBe('idp_unavailable');
  });

  it('uses client_secret_post when Basic is not offered', async () => {
    idp.discovery = { token_endpoint_auth_methods_supported: ['client_secret_post'] };
    await login(idp, provider);
    expect(idp.tokenRequests[0]?.authorization).toBeNull();
    expect(idp.tokenRequests[0]?.body.get('client_id')).toBe(MOCK_CLIENT_ID);
  });

  it('protocol parameters cannot be overridden through authParams', () => {
    expect(() =>
      createOidcProvider({
        id: 'x',
        label: 'x',
        idp: 'oidc:x',
        issuer: MOCK_ISSUER,
        clientId: MOCK_CLIENT_ID,
        clientSecret: new Secret('s'),
        authParams: { redirect_uri: 'https://evil.example' },
      }),
    ).toThrow(TypeError);
  });
});

describe('Google', () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await createMockIdp();
  });
  const google = (hostedDomain?: string) =>
    createGoogleProvider({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: new Secret(MOCK_CLIENT_SECRET),
      fetch: idp.fetch,
      ...(hostedDomain === undefined ? {} : { hostedDomain }),
    });

  it('logs in and accepts both documented iss spellings', async () => {
    const who = await login(idp, google(), { redirect: 'https://b.example/auth/callback/google' });
    expect(who).toMatchObject({ idp: 'google', subject: 'g-1', email: 'owner@example.com' });
    idp.idTokenClaims = { iss: 'accounts.google.com' };
    expect((await login(idp, google())).subject).toBe('g-1');
  });

  it('hosted domain: the hd claim is enforced, not just hinted', async () => {
    const p = google('example.com');
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT,
      state: 's'.repeat(43),
      nonce: 'n'.repeat(43),
      codeChallenge: 'c'.repeat(43),
    });
    expect(url.searchParams.get('hd')).toBe('example.com');
    // Personal account (no hd claim) and another Workspace domain are refused.
    expect(await codeOf(login(idp, p))).toBe('hd_mismatch');
    idp.googleUser = { ...idp.googleUser, hd: 'evil.example' };
    expect(await codeOf(login(idp, p))).toBe('hd_mismatch');
    idp.googleUser = { ...idp.googleUser, hd: 'example.com' };
    expect((await login(idp, p)).email).toBe('owner@example.com');
  });

  it('refuses an unverified Google email', async () => {
    idp.googleUser = { ...idp.googleUser, email_verified: false };
    expect(await codeOf(login(idp, google()))).toBe('email_unverified');
  });
});

describe('GitHub', () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await createMockIdp();
  });
  const github = (orgs?: string[]) =>
    createGitHubProvider({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: new Secret(MOCK_CLIENT_SECRET),
      fetch: idp.fetch,
      ...(orgs === undefined ? {} : { orgs }),
    });

  it('subject is the numeric id; email is the verified primary address', async () => {
    const p = github();
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT,
      state: 's'.repeat(43),
      nonce: 'n'.repeat(43),
      codeChallenge: 'c'.repeat(43),
    });
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(await login(idp, p)).toEqual({
      idp: 'github',
      subject: '4242',
      email: 'owner@example.com',
      emailVerified: true,
      displayName: 'Octo Owner',
      orgs: [],
    });
  });

  it('an unverified primary email is refused even when another address is verified', async () => {
    idp.githubUser.emails = [
      { email: 'verified@example.com', primary: false, verified: true },
      { email: 'owner@example.com', primary: true, verified: false },
    ];
    expect(await codeOf(login(idp, github()))).toBe('email_unverified');
  });

  it('org membership: only active memberships of configured orgs count', async () => {
    idp.githubUser.orgs = { 'relic-org': 'active', other: 'active', pending: 'pending' };
    const p = github(['relic-org', 'pending', 'absent']);
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT,
      state: 's'.repeat(43),
      nonce: 'n'.repeat(43),
      codeChallenge: 'c'.repeat(43),
    });
    expect(url.searchParams.get('scope')).toContain('read:org');
    expect((await login(idp, p)).orgs).toEqual(['relic-org']);
  });

  it('an OAuth error answered with 200 is a refusal', async () => {
    expect(await codeOf(login(idp, github(), { verifier: 'w'.repeat(43) }))).toBe('idp_error');
  });
});

describe('GitHub token revocation (P4-13)', () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await createMockIdp();
  });
  const github = () =>
    createGitHubProvider({
      clientId: GITHUB_CLIENT_ID,
      clientSecret: new Secret(MOCK_CLIENT_SECRET),
      fetch: idp.fetch,
    });
  const complete = async (hooks?: CompleteHooks) => {
    const p = github();
    const verifier = 'v'.repeat(43);
    const url = await p.authorizationUrl({
      redirectUri: REDIRECT,
      state: 's'.repeat(43),
      nonce: 'n'.repeat(43),
      codeChallenge: await pkceChallenge(verifier),
    });
    const back = await idp.authorize(url);
    return p.complete(
      {
        code: back.searchParams.get('code') as string,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        nonce: 'n',
      },
      hooks,
    );
  };

  it('revokes the token once after a successful lookup, with Basic client auth', async () => {
    await complete();
    expect(idp.revocations).toHaveLength(1);
    const r = idp.revocations[0];
    expect(r?.clientId).toBe(GITHUB_CLIENT_ID);
    expect(r?.accessToken).toMatch(/^at-/);
    expect(r?.authorization).toBe(`Basic ${btoa(`${GITHUB_CLIENT_ID}:${MOCK_CLIENT_SECRET}`)}`);
  });

  it('revokes on refusals after the exchange (unverified email)', async () => {
    idp.githubUser.emails = [
      {
        email: 'owner@example.com',
        primary: true,
        verified: false,
      },
    ];
    expect(await codeOf(complete())).toBe('email_unverified');
    expect(idp.revocations).toHaveLength(1);
  });

  it('does not revoke when the code exchange itself failed', async () => {
    const p = github();
    await expect(
      p.complete({
        code: 'bad',
        redirectUri: REDIRECT,
        codeVerifier: 'v'.repeat(43),
        nonce: 'n',
      }),
    ).rejects.toThrow();
    expect(idp.revocations).toHaveLength(0);
  });

  it('a failed revocation never fails sign-in; the warning carries no token or secret', async () => {
    const warnings: unknown[] = [];
    for (const status of [500, 422, 'throw'] as const) {
      idp.revokeStatus = status;
      expect((await complete({ warn: (m, f) => warnings.push([m, f]) })).subject).toBe('4242');
    }
    expect(warnings).toHaveLength(3);
    const text = JSON.stringify(warnings);
    expect(text).not.toMatch(/at-\d/);
    expect(text).not.toContain(MOCK_CLIENT_SECRET);
    expect(text).toContain('500');
  });

  it('runs in the background when a hook is given', async () => {
    const tasks: Promise<unknown>[] = [];
    await complete({ background: (t) => tasks.push(t) });
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(idp.revocations).toHaveLength(1);
  });
});

describe('Cloudflare Access', () => {
  let idp: MockIdp;
  beforeEach(async () => {
    idp = await createMockIdp();
  });
  const access = () => createCloudflareAccessProvider({ team: CF_TEAM, audience: CF_AUD, fetch: idp.fetch });
  const headers = (token: string) => new Headers({ [CF_ACCESS_HEADER]: token });

  it('verifies the assertion against the team JWKS and AUD', async () => {
    expect(await access().verify(headers(await idp.accessAssertion()))).toEqual({
      idp: 'cf-access',
      subject: 'cf-user-1',
      email: 'owner@example.com',
      emailVerified: true,
      displayName: null,
    });
    expect(idp.jwksFetches(`${CF_TEAM}.cloudflareaccess.com`)).toBe(1);
  });

  it.each([
    ['wrong AUD', { aud: ['b'.repeat(64)] }, 'wrong_audience'],
    ['another team', { iss: 'https://other.cloudflareaccess.com' }, 'wrong_issuer'],
    ['expired', { exp: Math.floor(Date.now() / 1000) - 600 }, 'token_expired'],
    ['a service token (no email)', { email: undefined, sub: '', common_name: 'svc' }, 'email_missing'],
    ['an org token', { type: 'org' }, 'invalid_token'],
  ])('refuses %s', async (_n, claims, code) => {
    expect(await codeOf(access().verify(headers(await idp.accessAssertion(claims))))).toBe(code);
  });

  it('refuses a missing header and a forged signature', async () => {
    expect(await codeOf(access().verify(new Headers()))).toBe('missing_assertion');
    const forged = await idp.sign(
      {
        iss: `https://${CF_TEAM}.cloudflareaccess.com`,
        aud: [CF_AUD],
        sub: 'x',
        email: 'owner@example.com',
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      {},
      true,
    );
    expect(await codeOf(access().verify(headers(forged)))).toBe('invalid_token');
  });

  it('validates the team and AUD at construction', () => {
    expect(() => createCloudflareAccessProvider({ team: 'bad team', audience: CF_AUD })).toThrow(TypeError);
    expect(() => createCloudflareAccessProvider({ team: CF_TEAM, audience: 'x' })).toThrow(TypeError);
  });
});

describe('login transactions', () => {
  let storage: Storage;
  let now: number;
  const clock = { now: () => now };
  beforeEach(() => {
    now = 1_800_000_000_000;
    storage = createMemoryStorage({ now: clock.now });
  });

  it('round-trips once; replay finds nothing', async () => {
    const started = await startLogin(storage.kv, { provider: 'oidc', next: '/admin', setup: null }, clock);
    expect(started.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const tx = await finishLogin(
      storage.kv,
      { state: started.state, binding: started.binding, provider: 'oidc' },
      clock,
    );
    expect(tx.nonce).toBe(started.nonce);
    expect(await pkceChallenge(tx.codeVerifier)).toBe(started.codeChallenge);
    expect(
      await codeOf(
        finishLogin(storage.kv, { state: started.state, binding: started.binding, provider: 'oidc' }, clock),
      ),
    ).toBe('unknown_state');
    // Nothing secret in the key names: only hashes.
    const keys = (await storage.kv.list()).keys.map((k) => k.name).join(' ');
    expect(keys).not.toContain(started.state);
  });

  it('refuses a missing or foreign binding cookie, a provider mix-up, an expired or malformed state', async () => {
    const s = () => startLogin(storage.kv, { provider: 'oidc', next: '/admin', setup: null }, clock);
    let started = await s();
    expect(
      await codeOf(
        finishLogin(storage.kv, { state: started.state, binding: undefined, provider: 'oidc' }, clock),
      ),
    ).toBe('binding_mismatch');
    started = await s();
    const other = await s();
    expect(
      await codeOf(
        finishLogin(storage.kv, { state: started.state, binding: other.binding, provider: 'oidc' }, clock),
      ),
    ).toBe('binding_mismatch');
    started = await s();
    expect(
      await codeOf(
        finishLogin(
          storage.kv,
          { state: started.state, binding: started.binding, provider: 'github' },
          clock,
        ),
      ),
    ).toBe('provider_mismatch');
    started = await s();
    now += LOGIN_TTL_SECONDS * 1000 + 1;
    expect(
      await codeOf(
        finishLogin(storage.kv, { state: started.state, binding: started.binding, provider: 'oidc' }, clock),
      ),
    ).toBe('unknown_state');
    expect(
      await codeOf(
        finishLogin(storage.kv, { state: 'short', binding: started.binding, provider: 'oidc' }, clock),
      ),
    ).toBe('invalid_callback');
  });

  it('setup links are single use and expire', async () => {
    const link = await createSetupLink(storage.kv, 60 * 60_000, clock);
    expect(link.code).toMatch(/^rb_setup_[0-9a-f]{64}$/);
    const hash = (await setupCodeHash(link.code)) as string;
    expect(await setupLinkUsable(storage.kv, hash, clock)).toBe(true);
    expect(await consumeSetupLink(storage.kv, hash, clock)).toBe(true);
    expect(await consumeSetupLink(storage.kv, hash, clock)).toBe(false);
    const late = await createSetupLink(storage.kv, 60_000, clock);
    now += 60_001;
    const lateHash = (await setupCodeHash(late.code)) as string;
    expect(await setupLinkUsable(storage.kv, lateHash, clock)).toBe(false);
    expect(await consumeSetupLink(storage.kv, lateHash, clock)).toBe(false);
    expect(await setupCodeHash('rb_setup_nothex')).toBeNull();
    await expect(createSetupLink(storage.kv, 1000, clock)).rejects.toThrow(RangeError);
  });
});

describe('sign-in policy', () => {
  let storage: Storage;
  const policy = (over: Partial<LoginPolicy> = {}): LoginPolicy => ({
    emails: [],
    domains: [],
    githubOrgs: [],
    autoProvision: 'off',
    ...over,
  });
  const who = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
    idp: 'google',
    subject: 'g-1',
    email: 'owner@example.com',
    emailVerified: true,
    displayName: 'Owner',
    ...over,
  });
  beforeEach(() => {
    storage = createMemoryStorage();
  });

  it('denies unknown identities by default, even when allowlisted, unless auto-provisioning is on', async () => {
    expect(await resolveLoginUser(storage.users, who(), policy())).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
    expect(await resolveLoginUser(storage.users, who(), policy({ emails: ['owner@example.com'] }))).toEqual({
      ok: false,
      reason: 'not_provisioned',
    });
    const r = await resolveLoginUser(
      storage.users,
      who(),
      policy({ domains: ['example.com'], autoProvision: 'member' }),
    );
    expect(r.ok && r.outcome === 'provisioned' && r.user.role).toBe('member');
    expect((await storage.users.list()).length).toBe(1);
  });

  it('domains match exactly; GitHub orgs only for GitHub identities', () => {
    const p = policy({ domains: ['example.com'], githubOrgs: ['relic-org'] });
    expect(matchAllowlist(p, who({ email: 'a@sub.example.com' }))).toBeNull();
    expect(matchAllowlist(p, who({ email: 'a@example.com.evil' }))).toBeNull();
    expect(matchAllowlist(p, who({ email: 'a@example.com' }))).toBe('domain');
    expect(matchAllowlist(p, who({ email: 'x@y.z', orgs: ['relic-org'] }))).toBeNull();
    expect(matchAllowlist(p, who({ idp: 'github', email: 'x@y.z', orgs: ['relic-org'] }))).toBe('github_org');
  });

  it('binds a pre-created (unbound) user by email, then finds it by identity', async () => {
    await storage.users.create({ id: 'usr_1', email: 'owner@example.com', role: 'admin' });
    const first = await resolveLoginUser(storage.users, who(), policy());
    expect(first.ok && first.outcome).toBe('linked');
    expect((await storage.users.get('usr_1'))?.idpSubject).toBe('g-1');
    const again = await resolveLoginUser(storage.users, who(), policy());
    expect(again.ok && again.outcome).toBe('existing');
  });

  it('never moves an account to another identity by email; disabled users are refused', async () => {
    await storage.users.create({
      id: 'usr_1',
      email: 'owner@example.com',
      role: 'owner',
      idp: 'google',
      idpSubject: 'g-1',
    });
    for (const other of [who({ subject: 'g-2' }), who({ idp: 'github', subject: '9' })]) {
      expect(
        await resolveLoginUser(
          storage.users,
          other,
          policy({ autoProvision: 'admin', emails: ['owner@example.com'] }),
        ),
      ).toEqual({
        ok: false,
        reason: 'identity_conflict',
      });
    }
    await storage.users.update('usr_1', { disabledAt: 1 });
    expect(await resolveLoginUser(storage.users, who(), policy())).toEqual({
      ok: false,
      reason: 'user_disabled',
    });
  });

  it('a setup link makes the identity owner without an allowlist entry', async () => {
    const r = await resolveLoginUser(storage.users, who(), policy(), { ownerBootstrap: true });
    expect(r.ok && r.outcome === 'owner_bootstrap' && r.user.role).toBe('owner');
    // An existing member is promoted.
    await storage.users.create({ id: 'usr_m', email: 'm@example.com', role: 'member' });
    const p = await resolveLoginUser(
      storage.users,
      who({ subject: 'g-m', email: 'm@example.com' }),
      policy(),
      {
        ownerBootstrap: true,
      },
    );
    expect(p.ok && p.user.role).toBe('owner');
  });
});

describe('configuration', () => {
  const base = { RB_PUBLIC_URL: 'https://bridge.example.com' };
  const variable = (env: Record<string, string>) => {
    try {
      identitySettingsFromEnv(env);
    } catch (e) {
      if (e instanceof IdentityConfigError) return e.variable;
      throw e;
    }
    return null;
  };

  it('is off without providers', () => {
    expect(identitySettingsFromEnv({})).toBeNull();
    expect(variable({ RB_LOGIN_ALLOW_EMAILS: 'a@example.com' })).toBe('RB_LOGIN_ALLOW_EMAILS');
  });

  it('reads every provider and the policy', () => {
    const s = identitySettingsFromEnv({
      ...base,
      RB_GOOGLE_CLIENT_ID: 'g',
      RB_GOOGLE_CLIENT_SECRET: 'google-secret-value',
      RB_GOOGLE_HOSTED_DOMAIN: 'Example.com',
      RB_GITHUB_CLIENT_ID: 'h',
      RB_GITHUB_CLIENT_SECRET: 'hs',
      RB_OIDC_ISSUER: MOCK_ISSUER,
      RB_OIDC_CLIENT_ID: 'o',
      RB_OIDC_CLIENT_SECRET: 'os',
      RB_OIDC_NAME: 'corp',
      RB_CF_ACCESS_TEAM: `${CF_TEAM}.cloudflareaccess.com`,
      RB_CF_ACCESS_AUD: CF_AUD,
      RB_LOGIN_ALLOW_EMAILS: 'A@Example.com, b@example.com',
      RB_LOGIN_ALLOW_DOMAINS: '@corp.example',
      RB_LOGIN_ALLOW_GITHUB_ORGS: 'Relic-Org',
      RB_LOGIN_AUTO_PROVISION: 'member',
    });
    expect(s?.providers.map((p) => p.kind)).toEqual(['google', 'github', 'oidc', 'cf-access']);
    expect(s?.policy).toEqual({
      emails: ['a@example.com', 'b@example.com'],
      domains: ['corp.example'],
      githubOrgs: ['relic-org'],
      autoProvision: 'member',
    });
    expect(JSON.stringify(s)).not.toContain('google-secret-value');
    const providers = createIdentityProviders(s as NonNullable<typeof s>, { clock: systemClock });
    expect(providers.map((p) => [p.id, p.idp, p.kind])).toEqual([
      ['google', 'google', 'redirect'],
      ['github', 'github', 'redirect'],
      ['oidc-corp', 'oidc:corp', 'redirect'],
      ['cf-access', 'cf-access', 'header'],
    ]);
  });

  it.each([
    [{ RB_GOOGLE_CLIENT_ID: 'g' }, 'RB_GOOGLE_CLIENT_SECRET'],
    [{ RB_GITHUB_CLIENT_SECRET: 's' }, 'RB_GITHUB_CLIENT_ID'],
    [{ RB_OIDC_ISSUER: MOCK_ISSUER }, 'RB_OIDC_CLIENT_ID'],
    [
      { RB_OIDC_ISSUER: 'http://idp.example.com', RB_OIDC_CLIENT_ID: 'o', RB_OIDC_CLIENT_SECRET: 's' },
      'RB_OIDC_ISSUER',
    ],
    [{ RB_CF_ACCESS_AUD: CF_AUD }, 'RB_CF_ACCESS_TEAM'],
    [{ RB_CF_ACCESS_TEAM: CF_TEAM }, 'RB_CF_ACCESS_AUD'],
    [
      { RB_GITHUB_CLIENT_ID: 'h', RB_GITHUB_CLIENT_SECRET: 's', RB_LOGIN_AUTO_PROVISION: 'owner' },
      'RB_LOGIN_AUTO_PROVISION',
    ],
    [
      { RB_GITHUB_CLIENT_ID: 'h', RB_GITHUB_CLIENT_SECRET: 's', RB_LOGIN_ALLOW_DOMAINS: 'not a domain' },
      'RB_LOGIN_ALLOW_DOMAINS',
    ],
  ])('refuses %j (%s)', (env, name) => {
    expect(variable({ ...base, ...env })).toBe(name);
  });

  it('requires an origin-only public URL, https except for loopback', () => {
    const gh = { RB_GITHUB_CLIENT_ID: 'h', RB_GITHUB_CLIENT_SECRET: 's' };
    expect(variable(gh)).toBe('RB_PUBLIC_URL');
    expect(variable({ ...gh, RB_PUBLIC_URL: 'http://bridge.example.com' })).toBe('RB_PUBLIC_URL');
    expect(variable({ ...gh, RB_PUBLIC_URL: 'https://bridge.example.com/sub' })).toBe('RB_PUBLIC_URL');
    expect(parsePublicUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(parsePublicUrl('https://Bridge.Example.com')).toBe('https://bridge.example.com');
  });
});
