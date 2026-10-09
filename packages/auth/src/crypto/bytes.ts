// SPDX-License-Identifier: Apache-2.0
// Byte helpers on web-standard APIs only (ADR-0004): `atob`/`btoa`, `TextEncoder`, typed arrays.

const encoder = new TextEncoder();
/** `fatal`: invalid UTF-8 throws instead of being replaced, so a corrupted plaintext never decodes "successfully". */
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Big-endian unsigned 32-bit integer. */
export function u32(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError('u32 out of range');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]|[A-Za-z0-9_-])+={0,2}$/;

/**
 * Strict base64 decoding: standard or URL-safe alphabet (not mixed), padding optional, no whitespace inside.
 * Returns `null` for anything else, so callers can report "invalid" without echoing the input.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64_RE.test(text)) return null;
  const hasStd = /[+/]/.test(text);
  const hasUrl = /[-_]/.test(text);
  if (hasStd && hasUrl) return null;
  let std = text.replace(/=+$/, '').replaceAll('-', '+').replaceAll('_', '/');
  if (std.length % 4 === 1) return null;
  const padded = text.length - text.replace(/=+$/, '').length;
  if (padded > 0 && text.length % 4 !== 0) return null;
  std += '='.repeat((4 - (std.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(std);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  // Reject non-canonical encodings (stray low bits in the last character), so one key has one spelling.
  if (toBase64(out).replace(/=+$/, '') !== std.replace(/=+$/, '')) return null;
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Constant-time equality for secrets and secret-derived values (key check values, token hashes). Runs in time that
 * depends only on the lengths; lengths are not secret here (they are fixed by the format).
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.byteLength ^ b.byteLength;
  const n = Math.max(a.byteLength, b.byteLength);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
