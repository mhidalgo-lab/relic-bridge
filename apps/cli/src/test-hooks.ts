// SPDX-License-Identifier: Apache-2.0
import type { FetchLike, Logger } from '@relic-bridge/core';
import { ConfigError, type Env } from './config.ts';

/** Whether this build honours test-only hooks. False in the published build and when running from source. */
export const TEST_HOOKS_BUILD: boolean =
  typeof __RB_TEST_HOOKS__ !== 'undefined' && __RB_TEST_HOOKS__ === true;

export const TEST_ENDPOINT_VAR = 'RB_TEST_NERDGRAPH_URL';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The fetch used for NerdGraph. With `RB_TEST_NERDGRAPH_URL` (test builds only) every NerdGraph call goes to that
 * loopback URL instead, so the E2E test can serve fixtures. The release build refuses to start when it is set, and
 * even a test build only accepts a loopback http(s) URL, so the key can never be sent elsewhere.
 */
export function nerdGraphFetch(
  env: Env,
  logger: Logger,
  enabled: boolean = TEST_HOOKS_BUILD,
  baseFetch: FetchLike = (url, init) => fetch(url, init),
): FetchLike | undefined {
  const raw = env[TEST_ENDPOINT_VAR]?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (!enabled) {
    throw new ConfigError(
      `${TEST_ENDPOINT_VAR} is set, but this build does not allow test hooks.`,
      `Unset ${TEST_ENDPOINT_VAR}; it exists only for relic-bridge's own tests.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${TEST_ENDPOINT_VAR} is not a valid URL.`);
  }
  if (!(url.protocol === 'http:' || url.protocol === 'https:') || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError(`${TEST_ENDPOINT_VAR} must be an http(s) URL on a loopback host.`);
  }
  const target = url.toString();
  logger.warn('test hook active: NerdGraph calls go to a local endpoint', { endpoint: target });
  return (_url, init) => baseFetch(target, init);
}
