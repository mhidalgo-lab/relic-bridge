// SPDX-License-Identifier: Apache-2.0
// The admin API error model (P2-09): `{ "error": { "code", "message", "field"? } }` with stable codes. Messages name
// fields and ids only and pass through `redact()`, so a key or token pasted into the wrong field is never echoed.
import { isAccessError, isCryptoError, isKeyRejection } from '@relic-bridge/auth';
import { isRbError, redactHead } from '@relic-bridge/core';
import {
  ConflictError,
  InvalidInputError,
  LAST_OWNER_CONSTRAINT,
  NotFoundError,
  ReadOnlyStorageError,
  StorageError,
} from '@relic-bridge/storage';

export type AdminErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'not_permitted'
  | 'key_rejected'
  | 'upstream_unavailable'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'read_only'
  | 'rate_limited'
  | 'unavailable'
  | 'internal_error';

export const ADMIN_ERROR_CODES: readonly AdminErrorCode[] = Object.freeze([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'not_permitted',
  'key_rejected',
  'upstream_unavailable',
  'unsupported_media_type',
  'payload_too_large',
  'read_only',
  'rate_limited',
  'unavailable',
  'internal_error',
]);

const STATUS: Readonly<Record<AdminErrorCode, number>> = Object.freeze({
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_permitted: 422,
  key_rejected: 422,
  upstream_unavailable: 502,
  unsupported_media_type: 415,
  payload_too_large: 413,
  read_only: 409,
  rate_limited: 429,
  unavailable: 503,
  internal_error: 500,
});

const MAX_MESSAGE = 300;

/** An expected admin API failure. `message` must be safe to show (no submitted values). */
export class AdminApiError extends Error {
  readonly code: AdminErrorCode;
  readonly status: number;
  readonly field: string | undefined;
  /** Extra stable detail, e.g. the `RB_*` code New Relic's answer mapped to. */
  readonly detail: string | undefined;
  constructor(code: AdminErrorCode, message: string, options: { field?: string; detail?: string } = {}) {
    super(message);
    this.name = 'AdminApiError';
    this.code = code;
    this.status = STATUS[code];
    this.field = options.field;
    this.detail = options.detail;
  }
}

export function adminErrorBody(error: AdminApiError): Record<string, unknown> {
  return {
    error: {
      code: error.code,
      message: redactHead(error.message, MAX_MESSAGE).text.slice(0, MAX_MESSAGE),
      // A field name can come from the request (an unknown key), so it is redacted like the message.
      ...(error.field === undefined ? {} : { field: redactHead(error.field, 100).text.slice(0, 100) }),
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    },
  };
}

export function adminErrorResponse(error: AdminApiError, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(adminErrorBody(error)), {
    status: error.status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Map a thrown value to an API error. Domain, storage, New Relic and crypto errors have safe messages; anything else
 * is `null` (the caller answers `internal_error` without its message).
 */
export function toAdminApiError(error: unknown): AdminApiError | null {
  if (error instanceof AdminApiError) return error;
  if (isAccessError(error)) {
    const field = error.field === undefined ? {} : { field: error.field };
    switch (error.code) {
      case 'invalid_input':
        return new AdminApiError('invalid_request', error.message, field);
      case 'not_found':
        return new AdminApiError('not_found', error.message, field);
      case 'not_permitted':
        return new AdminApiError('not_permitted', error.message, field);
      case 'conflict':
        return new AdminApiError('conflict', error.message, field);
    }
  }
  if (isRbError(error)) {
    // A key New Relic refuses (or one that isn't a User key) vs. New Relic not answering right now.
    if (isKeyRejection(error)) {
      return new AdminApiError('key_rejected', error.message, { field: 'apiKey', detail: error.code });
    }
    return new AdminApiError(
      'upstream_unavailable',
      'New Relic could not be asked to validate the key; retry',
      {
        detail: error.code,
      },
    );
  }
  if (isCryptoError(error)) {
    return new AdminApiError('unavailable', 'credential encryption is unavailable (master key problem)', {
      detail: error.code,
    });
  }
  if (error instanceof NotFoundError) return new AdminApiError('not_found', error.message);
  if (error instanceof ReadOnlyStorageError) return new AdminApiError('read_only', error.message);
  if (error instanceof ConflictError && error.constraint === LAST_OWNER_CONSTRAINT) {
    // P4-16: demoting or disabling the last enabled owner. `detail` lets the UI and the CLI say so plainly.
    return new AdminApiError('conflict', 'the last enabled owner cannot be demoted or disabled', {
      detail: 'last_owner',
    });
  }
  if (error instanceof ConflictError) return new AdminApiError('conflict', conflictMessage(error.constraint));
  if (error instanceof InvalidInputError) {
    return new AdminApiError('invalid_request', error.message, { field: error.field });
  }
  // Any other storage failure (adapter outage, migration problem) and a busy/locked engine: an outage, not a bug.
  if (error instanceof StorageError || isBusyError(error)) {
    return new AdminApiError('unavailable', 'storage is unavailable; retry');
  }
  return null;
}

/** Seconds a client is told to wait before retrying a `503 unavailable`. */
export const ADMIN_RETRY_AFTER_SECONDS = 5;

const BUSY = /database is (locked|busy)|SQLITE_(BUSY|LOCKED)/i;

/** A SQLite engine error for a locked or busy database (the adapter does not wrap these). */
function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return BUSY.test(error.message) || (typeof code === 'string' && BUSY.test(code));
}

/** Storage constraint names are internal; say what they mean instead. */
function conflictMessage(constraint: string): string {
  if (constraint.includes('slug')) return 'a project with this slug already exists';
  if (constraint.includes('email')) return 'a user with this email already exists';
  return 'the change conflicts with existing data';
}
