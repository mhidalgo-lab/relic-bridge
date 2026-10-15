// SPDX-License-Identifier: Apache-2.0
// JWT verification for ID tokens and Cloudflare Access assertions, on `jose` (WebCrypto; ADR-0004). Asymmetric
// algorithms only: `none` is never accepted by jose, and HMAC (`HS*`) is excluded so a public key can't be used as a
// shared secret (algorithm confusion). Keys come from the issuer's JWKS, cached per provider instance (public keys,
// not request data) and refetched when a token names an unknown `kid` (key rotation), at most every 30 s.
import type { Clock, FetchLike } from '@relic-bridge/core';
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';
import { IdentityError } from './errors.ts';
import { IDP_MAX_RESPONSE_BYTES, IDP_TIMEOUT_MS, readCapped } from './http.ts';

export const ASYMMETRIC_ALGORITHMS: readonly string[] = Object.freeze([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
]);

/** Allowed clock difference with the IdP. */
export const CLOCK_SKEW_SECONDS = 60;
/** JWKS kept this long before a refetch (also refetched at once for an unknown `kid`, after the cooldown). */
export const JWKS_CACHE_MS: number = 10 * 60_000;
export const JWKS_COOLDOWN_MS = 30_000;

export type KeySource = JWTVerifyGetKey;

/** A cached remote JWKS fetched through `fetch` (tests inject a mock IdP). */
export function remoteKeySource(url: URL, fetch: FetchLike): KeySource {
  return createRemoteJWKSet(url, {
    // The JWKS body goes through the same size cap as every other IdP answer (P4-07): jose reads it whole otherwise.
    [customFetch]: async (u: string, init: RequestInit) => {
      // No redirects (jose asks for `manual` too; kept explicit so a JWKS answer only comes from the configured URL).
      const res = await fetch(u, { ...init, redirect: 'manual' });
      const text = await readCapped(res, IDP_MAX_RESPONSE_BYTES);
      return new Response(res.status === 204 || res.status === 304 ? null : text, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    },
    cacheMaxAge: JWKS_CACHE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: IDP_TIMEOUT_MS,
  });
}

export interface VerifyJwtOptions {
  /** Accepted `iss` values (exact match). */
  readonly issuers: readonly string[];
  /** Required `aud` value (the OAuth client id or the Access AUD tag). */
  readonly audience: string;
  /** Subset of `ASYMMETRIC_ALGORITHMS`. */
  readonly algorithms: readonly string[];
  readonly clock: Clock;
  /** Required claims besides `iss`, `aud`, `exp`. */
  readonly required?: readonly string[];
  /** Refuse tokens issued longer ago than this (ID tokens are minted for this login). */
  readonly maxAgeSeconds?: number;
  readonly what?: string;
}

function mapJoseError(error: unknown, what: string): IdentityError {
  if (error instanceof IdentityError) return error;
  if (error instanceof errors.JWTExpired) return new IdentityError('token_expired', `${what} has expired`);
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return new IdentityError('wrong_issuer', `${what} has an unexpected issuer`);
    if (error.claim === 'aud')
      return new IdentityError('wrong_audience', `${what} has an unexpected audience`);
    return new IdentityError('invalid_token', `${what} failed the ${error.claim} check`);
  }
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) {
    return new IdentityError('idp_unavailable', 'signing keys could not be loaded');
  }
  if (error instanceof errors.JOSEError) return new IdentityError('invalid_token', `${what} is not valid`);
  // fetch failures inside the JWKS loader, malformed input
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return new IdentityError('idp_unavailable', 'signing keys could not be loaded');
  }
  return new IdentityError('invalid_token', `${what} is not valid`);
}

/** Verify signature and standard claims; resolves the payload or throws an `IdentityError`. */
export async function verifyJwt(
  token: string,
  keys: KeySource,
  options: VerifyJwtOptions,
): Promise<JWTPayload> {
  const what = options.what ?? 'token';
  if (typeof token !== 'string' || token.length === 0 || token.length > 16 * 1024) {
    throw new IdentityError('invalid_token', `${what} is missing or too large`);
  }
  const algorithms = options.algorithms.filter((a) => ASYMMETRIC_ALGORITHMS.includes(a));
  if (algorithms.length === 0) throw new IdentityError('invalid_token', `no acceptable signing algorithm`);
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: [...options.issuers],
      audience: options.audience,
      algorithms,
      clockTolerance: CLOCK_SKEW_SECONDS,
      currentDate: new Date(options.clock.now()),
      requiredClaims: ['iss', 'aud', 'exp', ...(options.required ?? [])],
      ...(options.maxAgeSeconds === undefined ? {} : { maxTokenAge: options.maxAgeSeconds }),
    });
    return payload;
  } catch (error) {
    throw mapJoseError(error, what);
  }
}
