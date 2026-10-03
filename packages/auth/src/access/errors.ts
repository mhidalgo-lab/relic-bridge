// SPDX-License-Identifier: Apache-2.0
// Errors of the access domain services. Messages name fields and ids only, never key material or tokens.

export type AccessErrorCode =
  /** An argument breaks a rule (bad slug, unknown tool name, default account outside the allowed ones, …). */
  | 'invalid_input'
  /** A referenced row does not exist (or is revoked/disabled, which counts as gone). */
  | 'not_found'
  /** The grant would use a credential it may not use (someone else's personal key). */
  | 'not_permitted';

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  /** The input field at fault, when there is one. */
  readonly field: string | undefined;
  constructor(code: AccessErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
    this.field = field;
  }
}

export function isAccessError(error: unknown): error is AccessError {
  return error instanceof AccessError;
}
