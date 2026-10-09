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

  it('redacts any Authorization scheme and prefixed secret names (review P1-R)', () => {
    const cases: [string, string][] = [
      ['Authorization: Basic dXNlcjpwYXNzd29yZA==', `Authorization: Basic ${REDACTED}`],
      ['"authorization": "Token ghp_abcdef123456"', `"authorization": "Token ${REDACTED}"`],
      ['Proxy-Authorization: Digest abc123def', `Proxy-Authorization: Digest ${REDACTED}`],
      ['DB_PASSWORD=hunter2xyz', `DB_PASSWORD=${REDACTED}`],
      ['client_secret=abcdef123', `client_secret=${REDACTED}`],
      ['GET /cb?access_token=abcdef123456&state=1', `GET /cb?access_token=${REDACTED}&state=1`],
      ['aws_secret_access_key=wJalrXUtnFEMI', `aws_secret_access_key=${REDACTED}`],
      ['x-api-key: s3cr3tvalue', `x-api-key: ${REDACTED}`],
      ['{"refresh_token":"r1-abc"}', `{"refresh_token":"${REDACTED}"}`],
    ];
    for (const [input, expected] of cases) {
      expect(redact(input)).toBe(expected);
      expect(redact(redact(input))).toBe(expected);
    }
  });

  it('does not redact ordinary words that merely contain a secret-ish name', () => {
    for (const plain of [
      'max_tokens=100',
      'secretary=Jane',
      'tokens: 5',
      'password reset requested for user 42',
    ]) {
      expect(redact(plain)).toBe(plain);
    }
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

  it('redacts free-text secret shapes: URL credentials, JWT, tokens, PEM', () => {
    expect(redact('connect failed postgres://app:S3cret@db:5432/x')).toBe(
      'connect failed postgres://[REDACTED]@db:5432/x',
    );
    expect(redact('t eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.abc123 x')).toContain('[REDACTED_JWT]');
    expect(redact('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('[REDACTED_TOKEN]');
    expect(redact('-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----')).toBe(
      '[REDACTED_PRIVATE_KEY]',
    );
  });
});
