// SPDX-License-Identifier: Apache-2.0

import type { FetchLike } from '../../src/index.ts';
import cross_account from '../fixtures/nerdgraph/cross_account.json' with { type: 'json' };
import error_bad_nrql from '../fixtures/nerdgraph/error_bad_nrql.json' with { type: 'json' };
import error_invalid_user_key from '../fixtures/nerdgraph/error_invalid_user_key.json' with { type: 'json' };
import error_missing_variable from '../fixtures/nerdgraph/error_missing_variable.json' with { type: 'json' };
import error_unknown_account from '../fixtures/nerdgraph/error_unknown_account.json' with { type: 'json' };
import error_wrong_region_A_US_key_on_EU from '../fixtures/nerdgraph/error_wrong_region_A_US_key_on_EU.json' with {
  type: 'json',
};
import identity_A from '../fixtures/nerdgraph/identity_A.json' with { type: 'json' };
import nrql_async_start from '../fixtures/nerdgraph/nrql_async_start.json' with { type: 'json' };
import nrql_sync_1 from '../fixtures/nerdgraph/nrql_sync_1.json' with { type: 'json' };
import nrql_sync_3 from '../fixtures/nerdgraph/nrql_sync_3.json' with { type: 'json' };

interface Fixture {
  request: { query: string; variables: Record<string, unknown> };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

/** Static imports keep the helper runtime-agnostic (no node:fs), so it also works in the Workers test pool. */
export type FixtureName =
  | 'error_bad_nrql'
  | 'error_invalid_user_key'
  | 'error_missing_variable'
  | 'error_unknown_account'
  | 'error_wrong_region_A_US_key_on_EU'
  | 'identity_A'
  | 'cross_account'
  | 'nrql_async_start'
  | 'nrql_sync_1'
  | 'nrql_sync_3';

const FIXTURES: Record<FixtureName, Fixture> = {
  error_bad_nrql,
  error_invalid_user_key,
  error_missing_variable,
  error_unknown_account,
  error_wrong_region_A_US_key_on_EU,
  identity_A,
  cross_account,
  nrql_async_start,
  nrql_sync_1,
  nrql_sync_3,
};

export function loadFixture(name: FixtureName): Fixture {
  return FIXTURES[name];
}

/** A Response built from a sanitized P0-09 capture. */
export function fixtureResponse(name: FixtureName): Response {
  const { response } = loadFixture(name);
  return json(response.body, response.status);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown>; operationName: string };
  signal: AbortSignal | undefined;
}

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);

/** fetch that replays `steps` in order (the last one repeats) and records each call. */
export function scriptedFetch(...steps: Step[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as RecordedCall['body'],
      signal: init.signal ?? undefined,
    });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(init);
    if (!step) throw new Error('scriptedFetch: no steps');
    return step.clone();
  };
  return { fetch, calls };
}

/** A 200 response whose body streams `chunks` × `chunkSize` bytes, without a content-length. Counts pulled chunks. */
export function streamingResponse(
  chunks: number,
  chunkSize: number,
): { response: Response; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x20));
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    pulled: () => pulled,
  };
}
