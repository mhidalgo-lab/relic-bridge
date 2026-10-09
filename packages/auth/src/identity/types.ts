// SPDX-License-Identifier: Apache-2.0
// The identity provider contract (P4-01, ADR-0009 step 2).

/**
 * Who the IdP vouches for. Only produced after every check passed: signature, issuer, audience, expiry, nonce (OIDC),
 * and a **verified** email address. `email` is lowercased.
 */
export interface VerifiedIdentity {
  /** Stored as `users.idp`: `google`, `github`, `cf-access`, `oidc:<name>`. */
  readonly idp: string;
  /** Stable subject at the IdP (`sub`, or GitHub's numeric user id). Never the email or a GitHub login. */
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: true;
  readonly displayName: string | null;
  /** GitHub only: the configured organizations the user is an active member of (lowercase). */
  readonly orgs?: readonly string[];
}

/** What the login route hands a redirect provider to build the authorization request. */
export interface AuthorizationRequest {
  /** Exact, pre-registered redirect URI (`<public URL>/auth/callback/<provider id>`). */
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  /** PKCE S256 challenge of the transaction's verifier. */
  readonly codeChallenge: string;
}

/** What the callback route hands a redirect provider to finish the login. */
export interface AuthorizationResult {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  /** RFC 9207 `iss` callback parameter, when present. */
  readonly issuer?: string;
}

interface ProviderBase {
  /** URL key (`google`, `github`, `oidc-corp`, `cf-access`): `[a-z0-9-]{1,40}`. */
  readonly id: string;
  /** Shown on the sign-in page. */
  readonly label: string;
  /** `users.idp` value of identities from this provider. */
  readonly idp: string;
}

/** Authorization code flow (Google, GitHub, generic OIDC). */
export interface RedirectIdentityProvider extends ProviderBase {
  readonly kind: 'redirect';
  authorizationUrl(request: AuthorizationRequest): Promise<URL>;
  complete(result: AuthorizationResult): Promise<VerifiedIdentity>;
}

/** Identity asserted by a header from a trusted proxy (Cloudflare Access). */
export interface HeaderIdentityProvider extends ProviderBase {
  readonly kind: 'header';
  verify(headers: Headers): Promise<VerifiedIdentity>;
}

export type IdentityProvider = RedirectIdentityProvider | HeaderIdentityProvider;

/** Provider ids double as URL path segments. */
export const PROVIDER_ID_RE: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
