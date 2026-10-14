// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { REDACT_CUT_MARGIN, REDACTED, redact, redactHead, redactValue, Secret } from '../src/index.ts';

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

/** Repeat `piece` up to `size` characters. */
const fill = (piece: string, size: number): string =>
  piece.repeat(Math.ceil(size / piece.length)).slice(0, size);

/** Inputs shaped to make a backtracking pattern rescan the rest of the text from every position. */
const ADVERSARIAL = [
  'a.',
  'a-',
  'a+',
  'a_',
  'eyJ-',
  'eyJaaaaaaaaa.',
  '1.',
  'ab-',
  'sk-',
  'x://a:',
  'token ',
  '"\\',
];

describe('redaction work is linear in the input', () => {
  // Quadratic patterns took seconds on 64 KiB; linear ones take a few milliseconds. The bound is generous for slow CI.
  it.each(ADVERSARIAL)('redacts 64 KiB of %j quickly', (piece) => {
    const input = fill(piece, 64 * 1024);
    const started = performance.now();
    redact(input);
    expect(performance.now() - started).toBeLessThan(400);
  });

  it('still redacts prefixed names near and past the prefix bound', () => {
    for (const name of ['DB_PASSWORD', 'client_secret', 'x-api-key', 'my.app.access_token']) {
      for (const len of [0, 10, 39, 40, 41, 80, 500]) {
        const full = `${fill('a', len)}${len > 0 ? '_' : ''}${name}`;
        const out = redact(`${full}=hunter2xyz rest`);
        expect(out).not.toContain('hunter2xyz');
        expect(out.endsWith(`${full}=${REDACTED} rest`)).toBe(true);
        expect(redact(out)).toBe(out);
      }
    }
    expect(redact(`${fill('a.', 4000)}secret=s3cr3tvalue`)).not.toContain('s3cr3tvalue');
  });

  it('still redacts JWTs and URL credentials after long prefixes', () => {
    const jwt = 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.abc123';
    expect(redact(`${fill('a-', 5000)} ${jwt}`)).not.toContain(jwt);
    expect(redact(`${fill('a.', 5000)}x https://app:S3cret@db/x`)).not.toContain('S3cret');
    expect(redact(`${fill('a', 100)}https://app:S3cret@db/x`)).not.toContain('S3cret');
  });
});

describe('redactHead', () => {
  /** Secret, and a piece of its sensitive part that must never show up. */
  const SECRETS: [string, string][] = [
    [KEYS.user, 'ABCDEF'],
    [KEYS.ingest, 'abcdef'],
    [KEYS.license, 'a1a1a1'],
    [KEYS.token, 'FAKE8K'],
    // Built at runtime so no secret scanner trips on the source.
    [['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJl'].join('.'), 'eyJzdW'],
    ['password=hunter2hunter2hunter2', 'hunter'],
    ['https://user:S3cretS3cretS3cret@db.example.com/x', 'S3cret'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZDpwYXNzd29yZA==', 'dXNlcj'],
  ];
  const MAX = 100;

  it('keeps short input whole and redacted', () => {
    expect(redactHead(`a ${KEYS.user}`, MAX)).toEqual({ text: `a NRAK-${REDACTED}`, cut: false });
  });

  it('bounds the text it returns by the cap plus a margin, whatever the input size', () => {
    const { text, cut } = redactHead(fill('a.', 1024 * 1024), MAX);
    expect(cut).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX + REDACT_CUT_MARGIN);
    expect(text.slice(0, MAX)).toBe(fill('a.', MAX));
  });

  // Every secret placed at every offset around the cap and around the end of the redacted window: no slice of what
  // a caller keeps (the first MAX characters, or all of the text) may hold a fragment of the secret's sensitive part.
  it.each(SECRETS)('never leaves a fragment of %j at the cut', (secret, fragment) => {
    const edges = [MAX, MAX + REDACT_CUT_MARGIN];
    for (const edge of edges) {
      for (let at = edge - secret.length - 2; at <= edge + 2; at++) {
        // Filler that shrinks under redaction pulls the window's end into what a caller keeps.
        for (const filler of [fill('x', at), `password=${fill('x', Math.max(0, at - 9))}`]) {
          const input = `${filler.slice(0, Math.max(0, at))} ${secret} ${fill('y', 3 * REDACT_CUT_MARGIN)}`;
          const { text } = redactHead(input, MAX);
          expect(text).not.toContain(fragment);
        }
      }
    }
  });
});
