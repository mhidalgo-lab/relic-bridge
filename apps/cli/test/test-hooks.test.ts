// SPDX-License-Identifier: Apache-2.0
import { silentLogger } from '@relic-bridge/core';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.ts';
import { nerdGraphFetch, TEST_HOOKS_BUILD } from '../src/test-hooks.ts';

describe('nerdGraphFetch (test endpoint hook)', () => {
  it('is off when running from source', () => {
    expect(TEST_HOOKS_BUILD).toBe(false);
  });

  it('returns undefined when the variable is unset', () => {
    expect(nerdGraphFetch({}, silentLogger, true)).toBeUndefined();
    expect(nerdGraphFetch({ RB_TEST_NERDGRAPH_URL: ' ' }, silentLogger, true)).toBeUndefined();
  });

  it('is refused when the build has no test hooks', () => {
    expect(() =>
      nerdGraphFetch({ RB_TEST_NERDGRAPH_URL: 'http://127.0.0.1:1/' }, silentLogger, false),
    ).toThrow(ConfigError);
  });

  it.each(['https://evil.example/graphql', 'http://10.0.0.1/graphql', 'file:///etc/passwd', 'not a url'])(
    'only accepts loopback http(s): refuses %s',
    (url) => {
      expect(() => nerdGraphFetch({ RB_TEST_NERDGRAPH_URL: url }, silentLogger, true)).toThrow(ConfigError);
    },
  );

  it('redirects every call to the loopback URL', async () => {
    const seen: string[] = [];
    const f = nerdGraphFetch(
      { RB_TEST_NERDGRAPH_URL: 'http://localhost:4000/graphql' },
      silentLogger,
      true,
      async (url) => {
        seen.push(url);
        return new Response('{}');
      },
    );
    await f?.('https://api.newrelic.com/graphql', { method: 'POST' });
    expect(seen).toEqual(['http://localhost:4000/graphql']);
  });
});
