// SPDX-License-Identifier: Apache-2.0
// The Workers fetcher for client metadata documents (P5-03, T11): only with `global_fetch_strictly_public` (set in
// `wrangler.jsonc`, which these tests run under), never following redirects. No real fetch: the fetcher is injected.
import { describe, expect, it } from 'vitest';
import { hasStrictlyPublicFetch, strictlyPublicCimdFetch } from '../src/cimd-fetch.ts';

describe('strictlyPublicCimdFetch', () => {
  it('the Worker runs with global_fetch_strictly_public', () => {
    expect(hasStrictlyPublicFetch()).toBe(true);
  });

  it('asks for JSON with manual redirects and the caller’s signal', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher = strictlyPublicCimdFetch((async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/' } });
    }) as unknown as typeof fetch);
    expect(fetcher).not.toBeNull();
    const ac = new AbortController();
    const res = await fetcher?.('https://claude.ai/oauth/claude-code-client-metadata', { signal: ac.signal });
    expect(res?.status).toBe(302);
    expect(seen[0]?.url).toBe('https://claude.ai/oauth/claude-code-client-metadata');
    expect(seen[0]?.init).toMatchObject({ method: 'GET', redirect: 'manual', signal: ac.signal });
    expect(new Headers(seen[0]?.init?.headers).get('accept')).toBe('application/json');
  });

  it('is off when the runtime has no strictly-public fetch', () => {
    const g = globalThis as { Cloudflare?: unknown };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'Cloudflare');
    try {
      Object.defineProperty(globalThis, 'Cloudflare', {
        value: { compatibilityFlags: {} },
        configurable: true,
      });
      expect(hasStrictlyPublicFetch()).toBe(false);
      expect(strictlyPublicCimdFetch()).toBeNull();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'Cloudflare', saved);
      else delete g.Cloudflare;
    }
  });
});
