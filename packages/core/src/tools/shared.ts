// SPDX-License-Identifier: Apache-2.0
// Helpers shared by the built-in tools.
import { z } from 'zod';
import type { ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import { type FetchLike, type NerdGraphClient, nerdGraphFor } from '../nerdgraph/client.ts';
import type { TimeRange } from '../time/index.ts';

/**
 * Runtime dependencies for built-in tools. Set once when the tool list is built (tests, the CLI's mock endpoint);
 * never request data — credentials, accounts and limits always come from the per-request `ToolContext` (T21).
 */
export interface ToolDeps {
  /** fetch used for NerdGraph calls. Default: global fetch. */
  readonly fetch?: FetchLike;
  /** Wait used between retries and polls. Default: setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DAY_MS = 86_400_000;

/** A New Relic account id as a tool input. */
export const accountIdSchema: z.ZodNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Per-request NerdGraph client factory: dependencies are fixed, credentials come from the context. */
export function toolClient(deps: ToolDeps): (ctx: ToolContext) => NerdGraphClient {
  return (ctx: ToolContext) =>
    nerdGraphFor(ctx, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
}

/** Refuse a window longer than the connection's `maxWindowDays` (T5). */
export function assertWindowWithinLimit(
  range: Pick<TimeRange, 'windowMs'>,
  limits: { maxWindowDays: number },
): void {
  if (range.windowMs > limits.maxWindowDays * DAY_MS) {
    throw new RbError(
      ErrorCode.LimitQuery,
      `The window is longer than the ${limits.maxWindowDays}-day limit of this connection.`,
      { hint: `Use a shorter window, e.g. "last ${limits.maxWindowDays} days".` },
    );
  }
}
