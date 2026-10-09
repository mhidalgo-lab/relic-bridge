// SPDX-License-Identifier: Apache-2.0
// Generic OpenID Connect (authorization code + PKCE S256 + state + nonce), configured by discovery. Also the base of
// the Google provider. Every check fails closed:
// - discovery: the document's `issuer` must equal the configured issuer exactly (no mix-up through a lookalike
//   document), endpoints must be https (http only for a loopback issuer, local testing);
// - callback: RFC 9207 `iss` must equal the issuer when present, and must be present when the IdP advertises it;
// - ID token: signature from the issuer's JWKS with an asymmetric algorithm the IdP advertises, exact `iss`, `aud`
//   containing the client id (`azp` = client id when there are several audiences or `azp` is present), `exp`, `iat`
//   at most 10 min old, `nonce` equal to the transaction's;
// - identity: `sub` present, `email` present and `email_verified` true (from the ID token, else the userinfo endpoint
//   whose `sub` must match).
import { type Clock, type FetchLike, type Secret, systemClock } from '@relic-bridge/core';
import type { JWTPayload } from 'jose';
import { timingSafeEqual, utf8 } from '../crypto/bytes.ts';
import { IdentityError } from './errors.ts';
import { asRecord, checkEndpoint, idpJson, isLoopbackHostname } from './http.ts';
import { ASYMMETRIC_ALGORITHMS, type KeySource, remoteKeySource, verifyJwt } from './jwt.ts';
import {
  type AuthorizationRequest,
  type AuthorizationResult,
  canonicalEmail,
  type RedirectIdentityProvider,
  type VerifiedIdentity,
} from './types.ts';

/** Discovery documents are re-read after this long. */
export const DISCOVERY_CACHE_MS: number = 60 * 60_000;
/** An ID token must have been issued within this many seconds. */
export const ID_TOKEN_MAX_AGE_SECONDS = 600;
const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

export interface OidcMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: URL;
  readonly tokenEndpoint: URL;
  readonly jwksUri: URL;
  readonly userinfoEndpoint: URL | null;
  readonly algorithms: readonly string[];
  readonly tokenAuth: 'client_secret_basic' | 'client_secret_post';
  /** RFC 9207 `authorization_response_iss_parameter_supported`. */
  readonly issParameter: boolean;
}

export interface OidcProviderOptions {
  /** URL key (`oidc`, `google`, …). */
  readonly id: string;
  readonly label: string;
  /** `users.idp` (`oidc:<name>`, `google`). */
  readonly idp: string;
  /** Exact issuer identifier (`https://login.example.com`). */
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: Secret;
  readonly scopes?: readonly string[];
  /** Extra authorization request parameters (Google `hd`). Cannot override the protocol parameters. */
  readonly authParams?: Readonly<Record<string, string>>;
  /** Further `iss` spellings the ID token may carry (Google: `accounts.google.com`). */
  readonly extraIssuers?: readonly string[];
  /** Provider-specific claim checks (Google hosted domain); throw an `IdentityError` to refuse. */
  readonly checkClaims?: (claims: JWTPayload) => void;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

const PROTOCOL_PARAMS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
]);

/** RFC 6749 §2.3.1: form-urlencode both parts before Basic encoding. */
function basicAuth(id: string, secret: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  const raw = utf8(`${enc(id)}:${enc(secret)}`);
  let bin = '';
  for (const b of raw) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export function parseDiscovery(body: unknown, issuer: string): OidcMetadata {
  const doc = asRecord(body);
  const bad = (what: string) => new IdentityError('idp_unavailable', `discovery document: ${what}`);
  if (doc === null) throw bad('not an object');
  if (doc['issuer'] !== issuer) throw bad('issuer does not match the configured issuer');
  const loopback = isLoopbackHostname(new URL(issuer).hostname) && issuer.startsWith('http:');
  const authorizationEndpoint = checkEndpoint(doc['authorization_endpoint'], loopback);
  const tokenEndpoint = checkEndpoint(doc['token_endpoint'], loopback);
  const jwksUri = checkEndpoint(doc['jwks_uri'], loopback);
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) throw bad('missing or insecure endpoint');
  const userinfo =
    doc['userinfo_endpoint'] === undefined ? null : checkEndpoint(doc['userinfo_endpoint'], loopback);
  const types = doc['response_types_supported'];
  if (Array.isArray(types) && !types.includes('code')) throw bad('the code flow is not supported');
  const pkce = doc['code_challenge_methods_supported'];
  if (Array.isArray(pkce) && !pkce.includes('S256')) throw bad('PKCE S256 is not supported');
  const advertised = doc['id_token_signing_alg_values_supported'];
  // OIDC Discovery: RS256 is the default when the list is absent.
  const algorithms = (Array.isArray(advertised) ? advertised : ['RS256']).filter(
    (a): a is string => typeof a === 'string' && ASYMMETRIC_ALGORITHMS.includes(a),
  );
  if (algorithms.length === 0) throw bad('no asymmetric ID token signing algorithm');
  const methods = doc['token_endpoint_auth_methods_supported'];
  let tokenAuth: OidcMetadata['tokenAuth'] = 'client_secret_basic';
  if (Array.isArray(methods) && !methods.includes('client_secret_basic')) {
    if (methods.includes('client_secret_post')) tokenAuth = 'client_secret_post';
    else throw bad('no supported client authentication method');
  }
  return Object.freeze({
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    userinfoEndpoint: userinfo,
    algorithms: Object.freeze(algorithms),
    tokenAuth,
    issParameter: doc['authorization_response_iss_parameter_supported'] === true,
  });
}

const sameString = (a: string, b: string): boolean => timingSafeEqual(utf8(a), utf8(b));

/** `true` or the string `"true"` (some IdPs send strings); anything else is unverified. */
const isTrue = (v: unknown): boolean => v === true || v === 'true';

function displayNameOf(claims: Record<string, unknown>): string | null {
  const name = claims['name'] ?? claims['preferred_username'];
  return typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 200) : null;
}

export function createOidcProvider(options: OidcProviderOptions): RedirectIdentityProvider {
  const fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const clock = options.clock ?? systemClock;
  const scopes = options.scopes ?? DEFAULT_SCOPES;
  if (!scopes.includes('openid')) throw new TypeError('OIDC scopes must include openid');
  for (const k of Object.keys(options.authParams ?? {})) {
    if (PROTOCOL_PARAMS.has(k)) throw new TypeError(`authParams cannot set ${k}`);
  }
  const issuer = options.issuer;
  const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

  // Configuration cache of this provider instance (one per app): metadata and the public-key cache, never request
  // data. No in-flight promise is shared between requests (workerd ties I/O to the request that started it), so two
  // concurrent cold logins may both read the discovery document; the last one wins, both are equivalent.
  let cached: { metadata: OidcMetadata; keys: KeySource; until: number } | undefined;

  const metadata = async (): Promise<{ metadata: OidcMetadata; keys: KeySource }> => {
    if (cached && clock.now() < cached.until) return cached;
    const res = await idpJson(fetch, discoveryUrl, { headers: { accept: 'application/json' } }, 'discovery');
    if (res.status !== 200) throw new IdentityError('idp_unavailable', 'discovery document unavailable');
    const meta = parseDiscovery(res.body, issuer);
    // Keep the key cache when the JWKS location did not change.
    const keys =
      cached && cached.metadata.jwksUri.href === meta.jwksUri.href
        ? cached.keys
        : remoteKeySource(meta.jwksUri, fetch);
    cached = { metadata: meta, keys, until: clock.now() + DISCOVERY_CACHE_MS };
    return cached;
  };

  const tokenRequest = async (
    meta: OidcMetadata,
    result: AuthorizationResult,
  ): Promise<Record<string, unknown>> => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: result.redirectUri,
      code_verifier: result.codeVerifier,
    });
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (meta.tokenAuth === 'client_secret_basic') {
      headers['authorization'] = basicAuth(options.clientId, options.clientSecret.reveal());
    } else {
      form.set('client_id', options.clientId);
      form.set('client_secret', options.clientSecret.reveal());
    }
    const res = await idpJson(
      fetch,
      meta.tokenEndpoint.href,
      { method: 'POST', headers, body: form.toString() },
      'token endpoint',
    );
    const body = asRecord(res.body);
    if (res.status >= 500) throw new IdentityError('idp_unavailable', 'token endpoint failed');
    if (res.status !== 200 || body === null || typeof body['error'] === 'string') {
      throw new IdentityError('idp_error', 'the identity provider refused the authorization code');
    }
    return body;
  };

  const userinfo = async (
    meta: OidcMetadata,
    accessToken: unknown,
    subject: string,
  ): Promise<Record<string, unknown> | null> => {
    if (meta.userinfoEndpoint === null || typeof accessToken !== 'string' || accessToken === '') return null;
    const res = await idpJson(
      fetch,
      meta.userinfoEndpoint.href,
      { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } },
      'userinfo endpoint',
    );
    const body = asRecord(res.body);
    if (res.status !== 200 || body === null) return null;
    // OIDC Core §5.3.2: the userinfo `sub` must match the ID token's, or the response must not be used.
    if (body['sub'] !== subject) throw new IdentityError('invalid_token', 'userinfo subject mismatch');
    return body;
  };

  return {
    kind: 'redirect',
    id: options.id,
    label: options.label,
    idp: options.idp,

    async authorizationUrl(request: AuthorizationRequest): Promise<URL> {
      const { metadata: meta } = await metadata();
      const url = new URL(meta.authorizationEndpoint.href);
      for (const [k, v] of Object.entries(options.authParams ?? {})) url.searchParams.set(k, v);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', request.redirectUri);
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', request.state);
      url.searchParams.set('nonce', request.nonce);
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url;
    },

    async complete(result: AuthorizationResult): Promise<VerifiedIdentity> {
      const { metadata: meta, keys } = await metadata();
      // RFC 9207 (mix-up defence): an `iss` that is present must be ours; an IdP that advertises it must send it.
      if (result.issuer !== undefined ? result.issuer !== meta.issuer : meta.issParameter) {
        throw new IdentityError('issuer_mismatch', 'the authorization response names another issuer');
      }
      const tokens = await tokenRequest(meta, result);
      const idToken = tokens['id_token'];
      if (typeof idToken !== 'string')
        throw new IdentityError('invalid_token', 'no ID token in the response');
      const claims = await verifyJwt(idToken, keys, {
        issuers: [meta.issuer, ...(options.extraIssuers ?? [])],
        audience: options.clientId,
        algorithms: meta.algorithms,
        clock,
        required: ['sub', 'iat'],
        maxAgeSeconds: ID_TOKEN_MAX_AGE_SECONDS,
        what: 'ID token',
      });
      const aud = claims.aud;
      const azp = (claims as Record<string, unknown>)['azp'];
      if ((Array.isArray(aud) && aud.length > 1) || azp !== undefined) {
        if (azp !== options.clientId) {
          throw new IdentityError('wrong_audience', 'ID token authorized party is not this client');
        }
      }
      const nonce = (claims as Record<string, unknown>)['nonce'];
      if (typeof nonce !== 'string' || !sameString(nonce, result.nonce)) {
        throw new IdentityError('nonce_mismatch', 'ID token nonce does not match the login');
      }
      const subject = claims.sub;
      if (typeof subject !== 'string' || subject === '' || subject.length > 255) {
        throw new IdentityError('invalid_token', 'ID token has no usable subject');
      }
      options.checkClaims?.(claims);

      let source: Record<string, unknown> = claims as Record<string, unknown>;
      if (typeof source['email'] !== 'string') {
        source = (await userinfo(meta, tokens['access_token'], subject)) ?? source;
      }
      const email = canonicalEmail(source['email']);
      if (email === null) {
        throw new IdentityError(
          'email_missing',
          'the identity provider did not share a usable (ASCII) email address',
        );
      }
      if (!isTrue(source['email_verified'])) {
        throw new IdentityError(
          'email_unverified',
          'the email address is not verified by the identity provider',
        );
      }
      return Object.freeze({
        idp: options.idp,
        subject,
        email,
        emailVerified: true,
        displayName: displayNameOf(source) ?? displayNameOf(claims as Record<string, unknown>),
      });
    },
  };
}
