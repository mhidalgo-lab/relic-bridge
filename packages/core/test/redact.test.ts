// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { REDACTED, redact, redactValue, Secret } from '../src/index.ts';

const KEYS = {
  user: 'NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0',
  ingest: 'NRII-abcdefghijklmnopqrstuvwxyz012345',
  license: `${'a1'.repeat(18)}NRAL`,
  token: 'rb_live_FAKE8Kq2Lm9Np4Rs7Tv1Wy3Ab6Cd0Ef5Gh_x1y2z3',
};

describe('redact', () => {
  it.each(Object.entries(KEYS))('removes %s secrets', (_kind, secret) => {
    const out = redact(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out.startsWith('before ')).toBe(true);
  });

  it('keeps a short non-secret prefix for debugging', () => {
    expect(redact(KEYS.user)).toBe(`NRAK-${REDACTED}`);
    expect(redact(KEYS.token)).toBe(`rb_${REDACTED}`);
  });

  it('redacts Bearer credentials and key/value assignments', () => {
    expect(redact('Authorization: Bearer abcdefgh12345678')).not.toContain('abcdefgh12345678');
    expect(redact('API-Key: something-secret-1')).toBe(`API-Key: ${REDACTED}`);
    expect(redact('NEW_RELIC_API_KEY=xyz123secret')).toBe(`NEW_RELIC_API_KEY=${REDACTED}`);
    expect(redact('RB_MASTER_KEY=base64stuff==')).toBe(`RB_MASTER_KEY=${REDACTED}`);
    expect(redact('{"apiKey":"plainvalue"}')).toBe(`{"apiKey":"${REDACTED}"}`);
  });

  it('is idempotent and leaves ordinary text alone', () => {
    const once = redact(`key ${KEYS.user}`);
    expect(redact(once)).toBe(once);
    const plain = "SELECT count(*) FROM Transaction WHERE appName = 'token-service' SINCE 1 hour ago";
    expect(redact(plain)).toBe(plain);
  });
});

describe('redactValue', () => {
  it('blanks secret-named keys and scrubs nested strings', () => {
    const out = redactValue({
      apiKey: 'anything',
      headers: { Authorization: 'x', 'content-type': 'json' },
      nested: [{ note: `leaked ${KEYS.user}` }],
    });
    expect(out).toEqual({
      apiKey: REDACTED,
      headers: { Authorization: REDACTED, 'content-type': 'json' },
      nested: [{ note: `leaked NRAK-${REDACTED}` }],
    });
  });

  it('never reveals Secret instances and survives cycles', () => {
    const a: Record<string, unknown> = { key: new Secret(KEYS.user) };
    a['self'] = a;
    const json = JSON.stringify(redactValue(a));
    expect(json).not.toContain(KEYS.user);
    expect(json).toContain('[CIRCULAR]');
  });

  it('reduces errors to name and redacted message', () => {
    expect(redactValue(new Error(`bad key ${KEYS.user}`))).toEqual({
      name: 'Error',
      message: `bad key NRAK-${REDACTED}`,
    });
  });
});
