// SPDX-License-Identifier: Apache-2.0
// Property / fuzz tests for auth's input parsers (P8-01, THREAT_MODEL T1/T7/T8/T14): `Authorization` header and
// `rb_` token parsing, session cookies, PKCE, the master-key and identity settings from the environment, and the
// public URL. Bounded in the normal suite; `RB_FUZZ_RUNS` for longer runs (core/test/helpers/fuzz.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FUZZ_TIMEOUT, fuzzParams } from '../../core/test/helpers/fuzz.ts';
import { parseMasterKey } from '../src/crypto/keyring.ts';
import {
  bearerToken,
  CryptoError,
  checkTokenFormat,
  generateMasterKey,
  generateTokenString,
  IdentityConfigError,
  identitySettingsFromEnv,
  MAX_TOKEN_LENGTH,
  parsePublicUrl,
  parseSessionCookie,
  pkceChallenge,
} from '../src/index.ts';

const TOKEN_RE = /^rb_[a-z0-9]{2,4}_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/;

/** Strings near the shapes the parsers expect, plus arbitrary UTF-16. */
const tokenish = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 80 }),
  fc
    .tuple(
      fc.constantFrom('rb_', 'RB_', 'rb', 'rb__', ''),
      fc.stringMatching(/^[a-z0-9]{0,5}$/),
      fc.constantFrom('_', '-', ''),
      fc.string({ unit: fc.constantFrom(...'0aZ9_-+/= \t'.split('')), maxLength: 50 }),
      fc.constantFrom('_', ''),
      fc.string({ unit: fc.constantFrom(...'0aZ9_'.split('')), maxLength: 8 }),
    )
    .map((parts) => parts.join('')),
);

describe('Authorization header and rb_ tokens (T1)', { timeout: FUZZ_TIMEOUT }, () => {
  it('bearerToken: null, or one whitespace-free word of the header, never longer than allowed', () => {
    const header = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 120 }),
      fc
        .tuple(
          fc.constantFrom('Bearer', 'bearer', 'BEARER', 'Basic', 'Bearer:', 'Token', ''),
          fc.string({ unit: fc.constantFrom(' ', '\t', '\n', '\r', '\u00a0'), maxLength: 3 }),
          tokenish,
          fc.string({ unit: fc.constantFrom(' ', '\t', ',', 'x'), maxLength: 3 }),
        )
        .map((p) => p.join('')),
    );
    fc.assert(
      fc.property(fc.oneof(header, fc.constant(null), fc.constant(undefined)), (h) => {
        const token = bearerToken(h);
        if (token === null) return true;
        return (
          typeof h === 'string' &&
          h.length <= MAX_TOKEN_LENGTH + 32 &&
          /^\S+$/.test(token) &&
          h.includes(token) &&
          /^[ \t]*bearer[ \t]+/i.test(h)
        );
      }),
      fuzzParams(2000),
    );
  });

  it('bearerToken round-trips any scheme spelling and spacing around a real token', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('Bearer', 'bearer', 'BEARER', 'bEaReR'),
        fc.stringMatching(/^[ \t]{0,3}$/),
        fc.stringMatching(/^[ \t]{1,3}$/),
        fc.stringMatching(/^[ \t]{0,3}$/),
        (scheme, before, between, after) => {
          const t = generateTokenString();
          expect(bearerToken(`${before}${scheme}${between}${t}${after}`)).toBe(t);
        },
      ),
      fuzzParams(300),
    );
  });

  it('checkTokenFormat: never throws; null only for the exact shape with a matching checksum', () => {
    fc.assert(
      fc.property(fc.oneof(tokenish, fc.anything()), (value) => {
        const problem = checkTokenFormat(value);
        if (problem === null) return typeof value === 'string' && TOKEN_RE.test(value);
        return problem === 'malformed' || problem === 'bad_checksum';
      }),
      fuzzParams(2000),
    );
  });

  it('a random well-shaped token passes the checksum about once in 62^6 (never in a bounded run)', () => {
    const body = fc
      .tuple(
        fc.stringMatching(/^[a-z0-9]{2,4}$/),
        fc.stringMatching(/^[0-9A-Za-z]{43}$/),
        fc.stringMatching(/^[0-9A-Za-z]{6}$/),
      )
      .map(([env, secret, sum]) => `rb_${env}_${secret}_${sum}`);
    fc.assert(
      fc.property(body, (t) => checkTokenFormat(t) === 'bad_checksum'),
      fuzzParams(1000),
    );
  });

  it('generated tokens always pass, for every environment label', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9]{2,4}$/), (env) => {
        const t = generateTokenString(env);
        return TOKEN_RE.test(t) && t.length <= MAX_TOKEN_LENGTH && checkTokenFormat(t) === null;
      }),
      fuzzParams(500),
    );
  });
});

describe('session cookie (T14)', { timeout: FUZZ_TIMEOUT }, () => {
  it('parseSessionCookie: null, or the exact split of the value into a user id and a 43-character secret', () => {
    const cookieish = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 140 }),
      fc
        .tuple(
          fc.string({ unit: fc.constantFrom(...'usr_aZ9-.'.split('')), maxLength: 70 }),
          fc.constantFrom('.', '..', ''),
          fc.string({ unit: fc.constantFrom(...'aZ9_-.='.split('')), maxLength: 50 }),
        )
        .map((p) => p.join('')),
    );
    fc.assert(
      fc.property(fc.oneof(cookieish, fc.constant(undefined)), (value) => {
        const parsed = parseSessionCookie(value);
        if (parsed === null) return true;
        return (
          value !== undefined &&
          `${parsed.userId}.${parsed.secret}` === value &&
          /^[A-Za-z0-9_-]{1,64}$/.test(parsed.userId) &&
          /^[A-Za-z0-9_-]{43}$/.test(parsed.secret)
        );
      }),
      fuzzParams(2000),
    );
  });
});

describe('PKCE S256 (T14, RFC 7636)', { timeout: FUZZ_TIMEOUT }, () => {
  it('matches the RFC 7636 appendix B vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('every verifier gives a 43-character unpadded base64url challenge, and different verifiers differ', async () => {
    const verifier = fc.stringMatching(/^[A-Za-z0-9._~-]{43,128}$/);
    await fc.assert(
      fc.asyncProperty(verifier, verifier, async (a, b) => {
        const [ca, cb] = await Promise.all([pkceChallenge(a), pkceChallenge(b)]);
        expect(ca).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(ca === cb).toBe(a === b);
      }),
      fuzzParams(300),
    );
  });
});

describe('master key from the environment (T7/T8)', { timeout: FUZZ_TIMEOUT }, () => {
  it('parseMasterKey: CryptoError that never echoes the value, or exactly 32 non-constant bytes', () => {
    const keyish = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 80 }),
      fc
        .tuple(
          fc.constantFrom('', 'v1:', 'v0:', 'v999999:', 'v1000000:', 'V1:', 'v1', 'v01:'),
          fc.uint8Array({ minLength: 0, maxLength: 40 }),
          fc.constantFrom('std', 'url', 'nopad', 'junk'),
        )
        .map(([prefix, bytes, style]) => {
          let b = btoa(String.fromCharCode(...bytes));
          if (style === 'url') b = b.replace(/\+/g, '-').replace(/\//g, '_');
          if (style === 'nopad') b = b.replace(/=+$/, '');
          if (style === 'junk') b = `${b}!`;
          return `${prefix}${b}`;
        }),
    );
    fc.assert(
      fc.property(keyish, (text) => {
        try {
          const parsed = parseMasterKey(text);
          expect(parsed.bytes.byteLength).toBe(32);
          expect(parsed.bytes.every((b) => b === parsed.bytes[0])).toBe(false);
          expect(Number.isInteger(parsed.version) && parsed.version >= 1 && parsed.version <= 999_999).toBe(
            true,
          );
        } catch (error) {
          expect(error).toBeInstanceOf(CryptoError);
          const trimmed = text.trim();
          if (trimmed.length >= 8) {
            const e = error as CryptoError;
            expect(`${e.message} ${(e as { hint?: string }).hint ?? ''}`).not.toContain(trimmed);
          }
        }
      }),
      fuzzParams(1000),
    );
  });

  it('round-trips generated keys of every version', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999_999 }), (version) => {
        expect(parseMasterKey(generateMasterKey(version)).version).toBe(version);
      }),
      fuzzParams(300),
    );
  });
});

describe('identity settings and the public URL (T14)', { timeout: FUZZ_TIMEOUT }, () => {
  it('parsePublicUrl: null, or a bare https origin (http only on loopback)', () => {
    const urlish = fc.oneof(
      fc.webUrl({ withQueryParameters: true, withFragments: true }),
      fc.string({ unit: 'binary', maxLength: 80 }),
      fc
        .tuple(
          fc.constantFrom(
            'https://',
            'http://',
            'HTTPS://',
            'javascript:',
            '//',
            'https:/',
            'http://user:pw@',
          ),
          fc.constantFrom(
            'localhost',
            '127.0.0.1',
            '[::1]',
            'example.com',
            'localhost.evil.example',
            '127.0.0.1.nip.io',
          ),
          fc.constantFrom('', '/', ':8443', '/path', '?q', '#f', '\\@evil.example'),
        )
        .map((p) => p.join('')),
    );
    fc.assert(
      fc.property(urlish, (value) => {
        const origin = parsePublicUrl(value);
        if (origin === null) return true;
        const u = new URL(origin);
        expect(u.origin).toBe(origin);
        expect(u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)).toBe(
          true,
        );
        return true;
      }),
      fuzzParams(1000),
    );
  });

  it('identitySettingsFromEnv: random RB_* values give settings or IdentityConfigError, and never echo a secret', () => {
    const NAMES = [
      'RB_PUBLIC_URL',
      'RB_GOOGLE_CLIENT_ID',
      'RB_GOOGLE_CLIENT_SECRET',
      'RB_GOOGLE_HOSTED_DOMAIN',
      'RB_GITHUB_CLIENT_ID',
      'RB_GITHUB_CLIENT_SECRET',
      'RB_GITHUB_ALLOWED_ORGS',
      'RB_OIDC_ISSUER',
      'RB_OIDC_CLIENT_ID',
      'RB_OIDC_CLIENT_SECRET',
      'RB_OIDC_NAME',
      'RB_CF_ACCESS_TEAM',
      'RB_CF_ACCESS_AUD',
      'RB_SIGN_IN_ALLOWED_DOMAINS',
      'RB_SESSION_IDLE_MINUTES',
      'RB_SESSION_MAX_HOURS',
      'RB_ALLOWED_EMAILS',
    ];
    const SECRET = 'S3cr3t-fuzz-value-0123456789';
    const value = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 40 }),
      fc.constantFrom(
        'https://rb.example.com',
        'http://localhost:8787',
        'abc123.apps.googleusercontent.com',
        'Iv1.0123456789abcdef',
        'example.com',
        'team',
        '30',
        '0',
        '-1',
        'on',
        SECRET,
      ),
    );
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...NAMES), value, { maxKeys: 8 }), (env) => {
        try {
          identitySettingsFromEnv(env);
        } catch (error) {
          expect(error).toBeInstanceOf(IdentityConfigError);
          expect((error as Error).message).not.toContain(SECRET);
        }
      }),
      fuzzParams(1000),
    );
  });
});
