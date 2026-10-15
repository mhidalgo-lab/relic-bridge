// SPDX-License-Identifier: Apache-2.0
// GitHub sign-in (OAuth app; GitHub is not an OIDC provider for users). Authorization code + PKCE S256 + `state`
// (GitHub supports PKCE since 2025-07). There is no ID token, so the identity is read from the API with the fresh
// access token, which is then dropped (never stored):
// - subject: the numeric user id (logins can be renamed and re-registered, ids can't);
// - email: the **primary** address, and only if GitHub marks it verified (`GET /user/emails`, scope `user:email`);
// - orgs: for each configured organization, `GET /user/memberships/orgs/{org}` must say `state: active` (scope
//   `read:org`); a pending invitation or a 404/403 is not membership.
import { type FetchLike, outboundFetch, type Secret } from '@relic-bridge/core';
import { IdentityError } from './errors.ts';
import { asRecord, IDP_TIMEOUT_MS, idpJson } from './http.ts';
import {
  type AuthorizationRequest,
  type AuthorizationResult,
  type CompleteHooks,
  canonicalEmail,
  type RedirectIdentityProvider,
  type VerifiedIdentity,
} from './types.ts';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_URL = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
/** GitHub organization logins. */
export const GITHUB_ORG_RE: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export interface GitHubProviderOptions {
  readonly clientId: string;
  readonly clientSecret: Secret;
  /** Organizations whose active members are reported in `orgs` (lowercase logins). Adds the `read:org` scope. */
  readonly orgs?: readonly string[];
  readonly fetch?: FetchLike;
}

export function createGitHubProvider(options: GitHubProviderOptions): RedirectIdentityProvider {
  const fetch = options.fetch ?? outboundFetch;
  const orgs = (options.orgs ?? []).map((o) => o.toLowerCase());
  for (const o of orgs) if (!GITHUB_ORG_RE.test(o)) throw new TypeError('invalid GitHub organization name');
  const scope = ['read:user', 'user:email', ...(orgs.length > 0 ? ['read:org'] : [])].join(' ');

  const api = async (path: string, token: string) =>
    idpJson(
      fetch,
      `${GITHUB_API_URL}${path}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'relic-bridge',
          'x-github-api-version': GITHUB_API_VERSION,
        },
      },
      'GitHub API',
    );

  /**
   * Revoke the user access token (`DELETE /applications/{client_id}/token`, Basic auth with the client credentials,
   * 204 on success). Best effort: never throws; a failure is reported by status or error class only, never the token.
   */
  const revoke = async (token: string, hooks: CompleteHooks | undefined): Promise<void> => {
    const warn = (reason: string, status?: number) =>
      hooks?.warn?.('GitHub token revocation failed', {
        provider: 'github',
        reason,
        ...(status === undefined ? {} : { status }),
      });
    try {
      const basic = btoa(`${options.clientId}:${options.clientSecret.reveal()}`);
      const res = await fetch(
        `${GITHUB_API_URL}/applications/${encodeURIComponent(options.clientId)}/token`,
        {
          method: 'DELETE',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Basic ${basic}`,
            'content-type': 'application/json',
            'user-agent': 'relic-bridge',
            'x-github-api-version': GITHUB_API_VERSION,
          },
          body: JSON.stringify({ access_token: token }),
          redirect: 'manual',
          signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
        },
      );
      await res.body?.cancel().catch(() => undefined);
      // 404: the token is already gone (nothing lingers).
      if (res.status !== 204 && res.status !== 404) warn('status', res.status);
    } catch {
      warn('network');
    }
  };

  return {
    kind: 'redirect',
    id: 'github',
    label: 'GitHub',
    idp: 'github',

    async authorizationUrl(request: AuthorizationRequest): Promise<URL> {
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('scope', scope);
      url.searchParams.set('state', request.state);
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('allow_signup', 'false');
      return url;
    },

    async complete(result: AuthorizationResult, hooks?: CompleteHooks): Promise<VerifiedIdentity> {
      const form = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret.reveal(),
        code: result.code,
        redirect_uri: result.redirectUri,
        code_verifier: result.codeVerifier,
      });
      const res = await idpJson(
        fetch,
        GITHUB_TOKEN_URL,
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        },
        'GitHub token endpoint',
      );
      if (res.status >= 500) throw new IdentityError('idp_unavailable', 'GitHub token endpoint failed');
      const body = asRecord(res.body);
      // GitHub answers OAuth errors with 200 and an `error` field.
      const token = body?.['access_token'];
      if (
        res.status !== 200 ||
        body === null ||
        typeof body['error'] === 'string' ||
        typeof token !== 'string'
      ) {
        throw new IdentityError('idp_error', 'GitHub refused the authorization code');
      }

      try {
        return await lookup(token);
      } finally {
        // The token is dropped at GitHub as soon as the lookup is over, on success and on refusals alike.
        const task = revoke(token, hooks);
        if (hooks?.background) hooks.background(task);
        else await task;
      }
    },
  };

  async function lookup(token: string): Promise<VerifiedIdentity> {
    const user = await api('/user', token);
    const u = asRecord(user.body);
    if (user.status !== 200 || u === null)
      throw new IdentityError('idp_unavailable', 'GitHub user lookup failed');
    const id = u['id'];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new IdentityError('invalid_token', 'GitHub returned no user id');
    }

    const emails = await api('/user/emails', token);
    if (emails.status !== 200 || !Array.isArray(emails.body)) {
      throw new IdentityError('email_missing', 'GitHub did not share the email addresses (scope user:email)');
    }
    const primary = emails.body.map(asRecord).find((e) => e !== null && e['primary'] === true);
    const email = canonicalEmail(primary?.['email']);
    if (email === null) {
      throw new IdentityError(
        'email_missing',
        'the GitHub account has no usable (ASCII) primary email address',
      );
    }
    if (primary?.['verified'] !== true) {
      throw new IdentityError('email_unverified', 'the primary GitHub email address is not verified');
    }

    const member: string[] = [];
    for (const org of orgs) {
      const m = await api(`/user/memberships/orgs/${encodeURIComponent(org)}`, token);
      if (m.status === 200 && asRecord(m.body)?.['state'] === 'active') member.push(org);
      else if (m.status >= 500) throw new IdentityError('idp_unavailable', 'GitHub membership lookup failed');
    }

    const name = typeof u['name'] === 'string' && u['name'].trim() !== '' ? u['name'] : u['login'];
    return Object.freeze({
      idp: 'github',
      subject: String(id),
      email,
      emailVerified: true,
      displayName: typeof name === 'string' ? name.trim().slice(0, 200) : null,
      orgs: Object.freeze(member),
    });
  }
}
