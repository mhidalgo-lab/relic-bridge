// SPDX-License-Identifier: Apache-2.0
// Access token format (ADR-0009, P2-05): `rb_<env>_<secret>_<checksum>`. WebCrypto only, no I/O, no module state
// beyond constant tables.
//
// - `env`: 2-4 lowercase letters/digits (default `live`); lets a reader tell deployments apart, covered by the checksum.
// - `secret`: 43 base62 characters, each drawn uniformly by rejection sampling from `crypto.getRandomValues`
//   (43 × log2(62) ≈ 256.03 bits).
// - `checksum`: CRC-32 of `rb_<env>_<secret>` as 6 fixed-width base62 characters, so a typo or a random string is
//   rejected offline, before any storage read. CRC-32 catches every single-character change (a burst ≤ 32 bits).
//
// The `rb_` prefix makes leaks detectable: `.gitleaks.toml` (`relic-bridge-access-token`) and core's `redact()` match it.
import { toHex, utf8 } from '../crypto/bytes.ts';

export const TOKEN_PREFIX = 'rb_';
export const DEFAULT_TOKEN_ENV = 'live';
export const TOKEN_SECRET_CHARS = 43;
export const TOKEN_CHECKSUM_CHARS = 6;
/** Characters kept for display (`rb_live_Ab3d`): the storage limit, at most 6 secret characters (≤ 36 bits). */
export const TOKEN_DISPLAY_CHARS = 12;
/** Longest well-formed token; anything longer is refused before any work. */
export const MAX_TOKEN_LENGTH: number =
  TOKEN_PREFIX.length + 4 + 1 + TOKEN_SECRET_CHARS + 1 + TOKEN_CHECKSUM_CHARS;

const ENV_RE = /^[a-z0-9]{2,4}$/;
const TOKEN_RE = /^rb_([a-z0-9]{2,4})_([0-9A-Za-z]{43})_([0-9A-Za-z]{6})$/;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Largest multiple of 62 that fits a byte: bytes at or above it are discarded so every character is uniform. */
const REJECT_AT = 248;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, as zlib) of ASCII/UTF-8 text. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const b of utf8(text)) crc = (CRC_TABLE[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function checksumOf(body: string): string {
  let value = crc32(body);
  let out = '';
  for (let i = 0; i < TOKEN_CHECKSUM_CHARS; i++) {
    out = BASE62[value % 62] + out;
    value = Math.floor(value / 62);
  }
  return out;
}

function randomBase62(length: number): string {
  let out = '';
  const buf = new Uint8Array(64);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= REJECT_AT) continue;
      out += BASE62[b % 62];
      if (out.length === length) break;
    }
  }
  buf.fill(0);
  return out;
}

export function isTokenEnv(env: unknown): env is string {
  return typeof env === 'string' && ENV_RE.test(env);
}

/** A new random token. The caller wraps it in `Secret` at once and stores only {@link hashToken}'s output. */
export function generateTokenString(env: string = DEFAULT_TOKEN_ENV): string {
  if (!isTokenEnv(env)) throw new TypeError('token env must be 2-4 lowercase letters or digits');
  const body = `${TOKEN_PREFIX}${env}_${randomBase62(TOKEN_SECRET_CHARS)}`;
  return `${body}_${checksumOf(body)}`;
}

export type TokenFormatProblem = 'malformed' | 'bad_checksum';

/**
 * Offline check: shape, then checksum. Never touches storage, so random strings cost no read. Returns `null` when the
 * token is well formed. Lengths and the checksum are not secret (anyone holding the token can compute them).
 */
export function checkTokenFormat(token: unknown): TokenFormatProblem | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return 'malformed';
  const m = TOKEN_RE.exec(token);
  if (m === null) return 'malformed';
  const body = token.slice(0, token.length - TOKEN_CHECKSUM_CHARS - 1);
  return checksumOf(body) === m[3] ? null : 'bad_checksum';
}

/** The display prefix stored next to the hash (`rb_live_Ab3d`). */
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, TOKEN_DISPLAY_CHARS);
}

/**
 * SHA-256 of the whole token, lowercase hex (the `access_tokens.token_hash` column). An unkeyed hash is enough: the
 * input is a uniformly random 256-bit secret, so neither brute force nor a precomputed table applies (ADR-0009).
 */
export async function hashToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(token))));
}
