// SPDX-License-Identifier: Apache-2.0
// Shared run settings for the property / fuzz tests (P8-01). The normal suite runs each property a bounded number of
// times so `pnpm test` stays fast; a longer local run sets `RB_FUZZ_RUNS` (runs per property) and, to replay a
// failure, `RB_FUZZ_SEED` (fast-check prints the seed and path of every counterexample):
//
//   RB_FUZZ_RUNS=200000 pnpm vitest run fuzz
//
// Web-standard only (the Workers pool imports test helpers too): the environment is read through `globalThis`, and
// is simply absent there.
import type { Parameters } from 'fast-check';

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

function positiveInt(name: string): number | undefined {
  const raw = env(name)?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

/** Runs per property: `RB_FUZZ_RUNS` when set, else `base` (the bounded default for the normal suite). */
export function fuzzRuns(base: number): number {
  return positiveInt('RB_FUZZ_RUNS') ?? base;
}

/**
 * fast-check parameters for one property: `base` runs (or `RB_FUZZ_RUNS`), and `RB_FUZZ_SEED` to replay a failure.
 */
export function fuzzParams<T>(base: number, extra: Parameters<T> = {}): Parameters<T> {
  const seed = env('RB_FUZZ_SEED');
  const parsedSeed = seed === undefined || seed.trim() === '' ? undefined : Number(seed);
  return {
    ...extra,
    numRuns: fuzzRuns(base),
    ...(parsedSeed !== undefined && Number.isSafeInteger(parsedSeed) ? { seed: parsedSeed } : {}),
  };
}

/**
 * The vitest timeout (ms) for a property test: the default for the bounded suite, a day for a long `RB_FUZZ_RUNS` run.
 * Pass it as the last argument of `it(…)`.
 */
export const FUZZ_TIMEOUT: number = positiveInt('RB_FUZZ_RUNS') === undefined ? 30_000 : 86_400_000;
