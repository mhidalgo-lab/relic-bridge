// SPDX-License-Identifier: Apache-2.0
import type { CallToolResult } from '@modelcontextprotocol/server';
import { envelope } from './output/envelope.ts';
import { redact } from './redact.ts';

/**
 * Stable error codes. They are part of the public contract (agents and docs refer to them): never rename, only add.
 */
export const ErrorCode = {
  InputInvalid: 'RB_INPUT_INVALID',
  AuthUnauthorized: 'RB_AUTH_UNAUTHORIZED',
  AuthForbidden: 'RB_AUTH_FORBIDDEN',
  AuthInvalidKey: 'RB_AUTH_INVALID_KEY',
  AuthWrongRegion: 'RB_AUTH_WRONG_REGION',
  LimitQuery: 'RB_LIMIT_QUERY',
  LimitResponseTooLarge: 'RB_LIMIT_RESPONSE_TOO_LARGE',
  LimitRate: 'RB_LIMIT_RATE',
  NerdGraphError: 'RB_NERDGRAPH_ERROR',
  NerdGraphRateLimited: 'RB_NERDGRAPH_RATE_LIMITED',
  NerdGraphTimeout: 'RB_NERDGRAPH_TIMEOUT',
  NerdGraphUnavailable: 'RB_NERDGRAPH_UNAVAILABLE',
  BudgetExhausted: 'RB_BUDGET_EXHAUSTED',
  ToolDisabled: 'RB_TOOL_DISABLED',
  Internal: 'RB_INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface RbErrorOptions {
  /** What the agent (or user) can do about it, e.g. "Narrow the SINCE window". */
  hint?: string;
  /** Safe, structured details for the agent (never secrets; still redacted on output). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** An expected, agent-actionable failure. `message` must be safe to show to the client. */
export class RbError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: RbErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RbError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export const isRbError = (e: unknown): e is RbError => e instanceof RbError;

/** Metadata key carrying the error code on tool results, so clients can branch without parsing text. */
export const ERROR_META_KEY = 'relic-bridge/error';

/**
 * Map any thrown value to an MCP tool error result (`isError: true`).
 * Unknown errors never leak their message: they become RB_INTERNAL with a request reference.
 */
export function toToolErrorResult(error: unknown, requestId: string): CallToolResult {
  const rb = isRbError(error)
    ? error
    : new RbError(ErrorCode.Internal, `Internal error. Reference: ${requestId}`);
  const lines = [`${rb.code}: ${rb.message}`];
  if (rb.hint) lines.push(`Hint: ${rb.hint}`);
  // Details may carry New Relic text (e.g. candidate entity names): untrusted data, so enveloped like results (T6).
  if (rb.details && Object.keys(rb.details).length > 0) {
    lines.push(envelope(`Details: ${JSON.stringify(rb.details)}`, { source: 'error details' }));
  }
  return {
    isError: true,
    content: [{ type: 'text', text: redact(lines.join('\n')) }],
    _meta: { [ERROR_META_KEY]: { code: rb.code, requestId } },
  };
}
