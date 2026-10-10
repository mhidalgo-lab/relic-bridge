// SPDX-License-Identifier: Apache-2.0
// Google sign-in: OpenID Connect against `https://accounts.google.com` (discovery, PKCE, nonce), plus the optional
// hosted-domain restriction. The `hd` request parameter is only a UI hint (a user can remove it), so the `hd` claim of
// the verified ID token is what is enforced.
import type { Clock, FetchLike, Secret } from '@relic-bridge/core';
import { IdentityError } from './errors.ts';
import { createOidcProvider } from './oidc.ts';
import type { RedirectIdentityProvider } from './types.ts';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
/** Google documents both spellings of `iss` in its ID tokens. */
export const GOOGLE_ALT_ISSUER = 'accounts.google.com';

export interface GoogleProviderOptions {
  readonly clientId: string;
  readonly clientSecret: Secret;
  /** Google Workspace domain (`example.com`): only accounts of that domain may sign in. */
  readonly hostedDomain?: string;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
}

export function createGoogleProvider(options: GoogleProviderOptions): RedirectIdentityProvider {
  const hd = options.hostedDomain?.toLowerCase();
  return createOidcProvider({
    id: 'google',
    label: 'Google',
    idp: 'google',
    issuer: GOOGLE_ISSUER,
    extraIssuers: [GOOGLE_ALT_ISSUER],
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scopes: ['openid', 'email', 'profile'],
    authParams: hd === undefined ? { prompt: 'select_account' } : { prompt: 'select_account', hd },
    ...(hd === undefined
      ? {}
      : {
          checkClaims: (claims) => {
            const claim = (claims as Record<string, unknown>)['hd'];
            if (typeof claim !== 'string' || claim.toLowerCase() !== hd) {
              throw new IdentityError('hd_mismatch', 'the Google account is not in the allowed domain');
            }
          },
        }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
