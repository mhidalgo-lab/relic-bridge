// SPDX-License-Identifier: Apache-2.0
// Cloudflare Access: the Access proxy in front of the Worker signs each request's identity into the
// `Cf-Access-Jwt-Assertion` header. Anyone can send that header, so it is trusted only after verification against the
// team's JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`): RS256, `iss` = the team domain, `aud`
// containing this application's AUD tag, `exp`. The `CF_Authorization` cookie is ignored (it is readable by any
// application of the team domain). Service-token assertions carry no email and are refused.
import { type Clock, type FetchLike, outboundFetch, systemClock } from '@relic-bridge/core';
import { IdentityError } from './errors.ts';
import { type KeySource, remoteKeySource, verifyJwt } from './jwt.ts';
import { canonicalEmail, type HeaderIdentityProvider, type VerifiedIdentity } from './types.ts';

export const CF_ACCESS_HEADER = 'cf-access-jwt-assertion';
const TEAM_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const AUD_RE = /^[A-Za-z0-9_-]{16,256}$/;

/** `myteam`, `myteam.cloudflareaccess.com` or `https://myteam.cloudflareaccess.com/` → `myteam`; null when invalid. */
export function normalizeAccessTeam(value: string): string | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/$/, '')
    .replace(/\.cloudflareaccess\.com$/, '');
  return TEAM_RE.test(v) ? v : null;
}

export const isAccessAudience = (aud: string): boolean => AUD_RE.test(aud);

export interface CloudflareAccessOptions {
  /** Team name or team domain. */
  readonly team: string;
  /** The Access application's Application Audience (AUD) tag. */
  readonly audience: string;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

export function createCloudflareAccessProvider(options: CloudflareAccessOptions): HeaderIdentityProvider {
  const team = normalizeAccessTeam(options.team);
  if (team === null) throw new TypeError('invalid Cloudflare Access team name');
  if (!isAccessAudience(options.audience)) throw new TypeError('invalid Cloudflare Access AUD tag');
  const issuer = `https://${team}.cloudflareaccess.com`;
  const fetch = options.fetch ?? outboundFetch;
  const clock = options.clock ?? systemClock;
  const keys: KeySource = remoteKeySource(new URL(`${issuer}/cdn-cgi/access/certs`), fetch);

  return {
    kind: 'header',
    id: 'cf-access',
    label: 'Cloudflare Access',
    idp: 'cf-access',
    async verify(headers: Headers): Promise<VerifiedIdentity> {
      const token = headers.get(CF_ACCESS_HEADER);
      if (token === null || token.trim() === '') {
        throw new IdentityError('missing_assertion', 'no Cloudflare Access assertion on the request');
      }
      const claims = (await verifyJwt(token.trim(), keys, {
        issuers: [issuer],
        audience: options.audience,
        algorithms: ['RS256'],
        clock,
        required: ['sub'],
        what: 'Access assertion',
      })) as Record<string, unknown>;
      if (claims['type'] !== undefined && claims['type'] !== 'app') {
        throw new IdentityError('invalid_token', 'not an application assertion');
      }
      const subject = claims['sub'];
      const email = canonicalEmail(claims['email']);
      if (email === null) {
        // Service tokens: `common_name`, empty `sub`, no email.
        throw new IdentityError(
          'email_missing',
          'the Access assertion carries no user email (service token?)',
        );
      }
      if (typeof subject !== 'string' || subject === '' || subject.length > 255) {
        throw new IdentityError('invalid_token', 'the Access assertion has no subject');
      }
      // Access issued the assertion after its own IdP login for this email: Access is the email verifier here.
      return Object.freeze({
        idp: 'cf-access',
        subject,
        email,
        emailVerified: true,
        displayName: null,
      });
    },
  };
}
