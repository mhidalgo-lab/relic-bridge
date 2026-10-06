// SPDX-License-Identifier: Apache-2.0
// Sealing New Relic keys inside a config bundle (P7-06, THREAT_MODEL T29). WebCrypto only.
//
// passphrase --PBKDF2-HMAC-SHA-256 (600 000+ iterations, 16-byte random salt)--> 32-byte wrap key
// wrap key --AES-256-GCM, fresh 96-bit IV--> `{"keys":{ref: key}}`
// AAD = format label || KDF parameters || canonical JSON of the bundle's `credentials` (labels, regions, owners), so
// the metadata that decides which key lands on which credential cannot be swapped without failing authentication.
//
// The derivation runs where the passphrase is typed (the CLI). The server only ever receives the derived wrap key, so
// a Worker does no heavy KDF (its WebCrypto caps PBKDF2 at 100 000 iterations) and never sees the passphrase.
import { Secret } from '@relic-bridge/core';
import { AccessError } from '../access/errors.ts';
import { concatBytes, fromBase64, fromUtf8, toBase64, u32, utf8 } from '../crypto/bytes.ts';
import type { BundleCredential, BundleKdf, BundleSecrets, ConfigBundle } from './bundle.ts';

export const KDF_NAME = 'pbkdf2-sha256';
export const KDF_ITERATIONS = 600_000;
/** Refuse weaker bundles; and refuse absurd costs that would only be a denial of service on the importing CLI. */
export const MIN_KDF_ITERATIONS = 600_000;
export const MAX_KDF_ITERATIONS = 10_000_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const WRAP_KEY_BYTES = 32;
export const MIN_PASSPHRASE_CHARS = 12;
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const AAD_LABEL = 'relic-bridge-config/v1/secrets';

type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const invalid = (message: string, field?: string): AccessError =>
  new AccessError('invalid_input', message, field);

/** Fresh KDF parameters (random salt). */
export function newKdf(iterations: number = KDF_ITERATIONS): BundleKdf {
  return {
    name: KDF_NAME,
    iterations,
    salt: toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES))),
  };
}

/** Throws when `kdf` is not something this version writes or accepts. */
export function checkKdf(kdf: BundleKdf): Uint8Array<ArrayBuffer> {
  if (kdf.name !== KDF_NAME) throw invalid('secrets.kdf: unsupported key derivation', 'secrets');
  if (
    !Number.isSafeInteger(kdf.iterations) ||
    kdf.iterations < MIN_KDF_ITERATIONS ||
    kdf.iterations > MAX_KDF_ITERATIONS
  ) {
    throw invalid(`secrets.kdf: iterations must be ${MIN_KDF_ITERATIONS}-${MAX_KDF_ITERATIONS}`, 'secrets');
  }
  const salt = fromBase64(kdf.salt);
  if (salt === null || salt.byteLength !== SALT_BYTES) {
    throw invalid(`secrets.kdf: salt must be ${SALT_BYTES} bytes (base64)`, 'secrets');
  }
  return salt;
}

/** The passphrase rules shared by export and import. The passphrase itself is never echoed. */
export function checkPassphrase(passphrase: string): void {
  if ([...passphrase.normalize('NFC')].length < MIN_PASSPHRASE_CHARS) {
    throw invalid(`the passphrase must have at least ${MIN_PASSPHRASE_CHARS} characters`);
  }
}

/** PBKDF2-HMAC-SHA-256 of the NFC-normalised passphrase. Runs on the client; the result is the wrap key. */
export async function deriveWrapKey(passphrase: string, kdf: BundleKdf): Promise<Uint8Array<ArrayBuffer>> {
  checkPassphrase(passphrase);
  const salt = checkKdf(kdf);
  const material = utf8(passphrase.normalize('NFC'));
  try {
    const base = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: kdf.iterations },
      base,
      WRAP_KEY_BYTES * 8,
    );
    return new Uint8Array(bits);
  } finally {
    material.fill(0);
  }
}

/** Parse the base64 wrap key sent over the admin API (exactly 32 bytes). */
export function parseWrapKey(text: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64(text);
  if (bytes === null || bytes.byteLength !== WRAP_KEY_BYTES) {
    bytes?.fill(0);
    throw invalid(`wrapKey must be ${WRAP_KEY_BYTES} bytes (base64)`, 'wrapKey');
  }
  return bytes;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function aad(kdf: BundleKdf, credentials: readonly BundleCredential[]): Uint8Array<ArrayBuffer> {
  const head = utf8(`${AAD_LABEL}|${kdf.name}|${kdf.iterations}|${kdf.salt}|`);
  const meta = utf8(
    canonical(
      [...credentials]
        .map((c) => ({ ref: c.ref, label: c.label, region: c.region, owner: c.owner }))
        .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    ),
  );
  return concatBytes(u32(head.byteLength), head, u32(meta.byteLength), meta);
}

async function aesKey(wrapKey: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<WebCryptoKey> {
  if (wrapKey.byteLength !== WRAP_KEY_BYTES)
    throw invalid(`wrapKey must be ${WRAP_KEY_BYTES} bytes`, 'wrapKey');
  return crypto.subtle.importKey('raw', own(wrapKey), { name: 'AES-GCM' }, false, [usage]);
}

/** Seal `keys` (credential ref → NR key) under `wrapKey`. `kdf` must be the parameters the wrap key came from. */
export async function sealCredentialKeys(
  wrapKey: Uint8Array,
  kdf: BundleKdf,
  credentials: readonly BundleCredential[],
  keys: Readonly<Record<string, string>>,
): Promise<BundleSecrets> {
  checkKdf(kdf);
  const plain = utf8(JSON.stringify({ keys }));
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad(kdf, credentials), tagLength: 128 },
        await aesKey(wrapKey, 'encrypt'),
        plain,
      ),
    );
    return { kdf, cipher: 'aes-256-gcm', nonce: toBase64(iv), sealed: toBase64(sealed) };
  } finally {
    plain.fill(0);
  }
}

const WRONG =
  'the encrypted keys could not be opened: wrong passphrase, or the credentials in the file were modified';

/** Open `bundle.secrets`; `not_permitted` for a wrong passphrase or any modification (the two are not told apart). */
export async function openCredentialKeys(
  wrapKey: Uint8Array,
  bundle: ConfigBundle,
): Promise<ReadonlyMap<string, Secret>> {
  const secrets = bundle.secrets;
  if (secrets === undefined) return new Map();
  checkKdf(secrets.kdf);
  const iv = fromBase64(secrets.nonce);
  const sealed = fromBase64(secrets.sealed);
  if (secrets.cipher !== 'aes-256-gcm' || iv === null || iv.byteLength !== IV_BYTES || sealed === null) {
    throw invalid('secrets: malformed', 'secrets');
  }
  if (sealed.byteLength > MAX_PLAINTEXT_BYTES) throw invalid('secrets: too large', 'secrets');
  let plain: Uint8Array<ArrayBuffer>;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad(secrets.kdf, bundle.credentials), tagLength: 128 },
        await aesKey(wrapKey, 'decrypt'),
        sealed,
      ),
    );
  } catch {
    throw new AccessError('not_permitted', WRONG, 'secrets');
  }
  try {
    const parsed = JSON.parse(fromUtf8(plain)) as { keys?: Record<string, unknown> };
    const refs = new Set(bundle.credentials.map((c) => c.ref));
    const out = new Map<string, Secret>();
    for (const [ref, key] of Object.entries(parsed.keys ?? {})) {
      if (!refs.has(ref) || typeof key !== 'string' || key === '') throw new Error('shape');
      out.set(ref, new Secret(key));
    }
    return out;
  } catch {
    throw new AccessError('not_permitted', WRONG, 'secrets');
  } finally {
    plain.fill(0);
  }
}
