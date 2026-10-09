// SPDX-License-Identifier: Apache-2.0
// The deployed entry (`src/index.ts` via `wrangler.jsonc`) inside workerd: bindings exist and the Worker fails closed
// until the D1 adapter (P3-02) is the default storage.
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('Worker entry (wrangler.jsonc)', () => {
  it('declares the D1, KV and rate-limit bindings', () => {
    expect(typeof env.DB?.prepare).toBe('function');
    expect(typeof env.OAUTH_KV?.get).toBe('function');
    expect(typeof env.RATE_LIMITER?.limit).toBe('function');
    expect(env.RB_PLAN).toBe('free');
  });

  it('answers 503 with security headers while no storage adapter is available', async () => {
    const res = await exports.default.fetch('https://rb.example.workers.dev/health');
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });
});
