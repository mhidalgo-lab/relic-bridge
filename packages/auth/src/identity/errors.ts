// SPDX-License-Identifier: Apache-2.0
// Identity errors (P4-01, THREAT_MODEL T14). Codes are stable (logs, audit rows, tests); messages never contain tokens,
// codes, client secrets or IdP response bodies.

export type IdentityErrorCode =
  /** The IdP could not be reached, timed out, or answered something unusable (bad metadata, non-JSON, 5xx). */
  | 'idp_unavailable'
  /** The IdP refused (the callback carried `error=…`, or the token endpoint answered an OAuth error). */
  | 'idp_error'
  /** The callback lacks `code`/`state`, or carries values of the wrong shape. */
  | 'invalid_callback'
  /** No login transaction for this `state`: never issued, already used (replay) or expired. */
  | 'unknown_state'
  /** The login cookie is missing or belongs to another browser's transaction (login CSRF / session swap). */
  | 'binding_mismatch'
  /** A transaction of provider A came back to the callback of provider B (mix-up). */
  | 'provider_mismatch'
  /** RFC 9207: the callback's `iss` is not the expected issuer, or a required `iss` is missing. */
  | 'issuer_mismatch'
  /** Signature, algorithm, structure or a required claim is wrong. */
  | 'invalid_token'
  | 'token_expired'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'nonce_mismatch'
  /** The Cloudflare Access assertion header is absent. */
  | 'missing_assertion'
  | 'email_missing'
  | 'email_unverified'
  /** Google hosted-domain restriction: the `hd` claim is missing or another domain. */
  | 'hd_mismatch'
  /** The setup link is malformed, unknown, used or expired. */
  | 'setup_invalid';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export function isIdentityError(error: unknown): error is IdentityError {
  return error instanceof IdentityError;
}

/** A configuration variable is missing or invalid (boot error; names the variable, never its value). */
export class IdentityConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(message);
    this.name = 'IdentityConfigError';
    this.variable = variable;
  }
}
