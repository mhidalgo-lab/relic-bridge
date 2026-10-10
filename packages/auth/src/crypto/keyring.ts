// SPDX-License-Identifier: Apache-2.0
// Master keys and the versioned keyring (ADR-0007, THREAT_MODEL T7). WebCrypto only: runs on Node and Workers.
//
// A master key is 32 random bytes, written `v<N>:<base64>` (a bare base64 value is version 1). From each master key
// HKDF-SHA-256 derives, with separate `info` labels:
//   - the AES-256-GCM data key that encrypts NR keys (non-extractable `CryptoKey`), and
//   - a 32-byte key check value (KCV), stored in `settings` to detect a wrong master key before touching rows, and
//   - an HMAC-SHA-256 key for audit identity hashes (P4-16): a refused sign-in is correlatable, never reversible, and
//   - an HMAC-SHA-256 key for query cache entry ids plus an AES-256-GCM key for cached bodies on Workers (P7-02).
// The raw master key bytes are dropped (and zeroed) once both are derived.
import { Secret } from '@relic-bridge/core';
import type { EncryptedKey } from '@relic-bridge/storage';
import { concatBytes, fromBase64, fromUtf8, timingSafeEqual, toBase64, u32, utf8 } from './bytes.ts';
import { CryptoError } from './errors.ts';

export const MASTER_KEY_BYTES = 32;
/** Versions are small positive integers; the cap keeps them readable and inside SQLite/JS integer ranges. */
export const MAX_KEY_VERSION = 999_999;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
/** NR keys are ~40 characters; anything near this limit is a bug, not a key. */
export const MAX_PLAINTEXT_BYTES = 4096;
export const MAX_CREDENTIAL_ID_BYTES = 256;

const REDACTED = '[REDACTED]';

/** `CryptoKey`, spelled so it type-checks under both the DOM/webworker lib and `@types/node`. */
type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/** HKDF parameters. Changing any of these changes every derived key: treat as a storage format. */
export const HKDF_SALT: Uint8Array<ArrayBuffer> = utf8('relic-bridge/master-key/v1');
export const INFO_CREDENTIAL_KEY: Uint8Array<ArrayBuffer> = utf8('relic-bridge/credential-key/aes-256-gcm');
export const INFO_KEY_CHECK: Uint8Array<ArrayBuffer> = utf8('relic-bridge/key-check');
export const INFO_AUDIT_IDENTITY: Uint8Array<ArrayBuffer> = utf8('relic-bridge/audit-identity/hmac-sha-256');
export const INFO_QUERY_CACHE_ID: Uint8Array<ArrayBuffer> = utf8('relic-bridge/query-cache-id/hmac-sha-256');
export const INFO_QUERY_CACHE_DATA: Uint8Array<ArrayBuffer> = utf8(
  'relic-bridge/query-cache-data/aes-256-gcm',
);
/** Bytes of the HMAC kept in an identity hash: 128 bits, plenty to correlate, short in the audit row. */
export const IDENTITY_HASH_BYTES = 16;
/** AAD purpose label for NR keys stored in `credentials`. */
export const CREDENTIAL_AAD_PURPOSE: Uint8Array<ArrayBuffer> = utf8('relic-bridge/credential-key/v1');

/** A parsed master key. Internal: the bytes never leave this module except into WebCrypto. */
export interface ParsedMasterKey {
  readonly version: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** With the `u` flag, a surrogate range matches only unpaired surrogates. */
const LONE_SURROGATE_RE = /[\uD800-\uDFFF]/u;

const KEY_RE = /^(?:v([1-9][0-9]{0,5}):)?([A-Za-z0-9+/_=-]+)$/;

/**
 * Parse `[v<N>:]<base64 of 32 bytes>`. `name` is the variable it came from, used in error messages; the value
 * itself is never echoed.
 */
export function parseMasterKey(text: string, name = 'RB_MASTER_KEY'): ParsedMasterKey {
  const invalid = (why: string): CryptoError =>
    new CryptoError(
      'master_key_invalid',
      `${name} is not a valid master key: ${why}`,
      'Generate one with `relic-bridge keys generate` (32 random bytes, base64, optionally prefixed `v<N>:`).',
    );
  const m = KEY_RE.exec(text.trim());
  if (!m) throw invalid('expected [v<N>:]<base64>');
  const version = m[1] === undefined ? 1 : Number(m[1]);
  if (version > MAX_KEY_VERSION) throw invalid(`version must be 1..${MAX_KEY_VERSION}`);
  const bytes = fromBase64(m[2] ?? '');
  if (bytes === null) throw invalid('not valid base64');
  if (bytes.byteLength !== MASTER_KEY_BYTES) {
    bytes.fill(0);
    throw invalid(`expected ${MASTER_KEY_BYTES} bytes, got ${bytes.byteLength}`);
  }
  if (bytes.every((b) => b === bytes[0])) {
    bytes.fill(0);
    throw invalid('all bytes are equal (a placeholder, not a random key)');
  }
  return { version, bytes };
}

/** A new random master key, `v<N>:<base64>`. Printed once by `relic-bridge keys generate`; never stored by us. */
export function generateMasterKey(version = 1): string {
  if (!Number.isInteger(version) || version < 1 || version > MAX_KEY_VERSION) {
    throw new CryptoError('invalid_input', `key version must be an integer in 1..${MAX_KEY_VERSION}`);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES));
  const text = `v${version}:${toBase64(bytes)}`;
  bytes.fill(0);
  return text;
}

/** Derived per-version material. Internal. */
export interface VersionKeys {
  readonly aes: WebCryptoKey;
  readonly check: Uint8Array<ArrayBuffer>;
  /** HMAC-SHA-256, sign only, non-extractable. */
  readonly identity: WebCryptoKey;
  /** Query cache (P7-02): HMAC-SHA-256 for entry ids and AES-256-GCM for cached bodies. Non-extractable. */
  readonly cacheId: WebCryptoKey;
  readonly cacheData: WebCryptoKey;
}

/** HKDF-SHA-256 derivation of the data key and the key check value. Zeroes `masterKey` afterwards. */
export async function deriveVersionKeys(masterKey: Uint8Array<ArrayBuffer>): Promise<VersionKeys> {
  try {
    const base = await crypto.subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveKey', 'deriveBits']);
    const aes = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO_CREDENTIAL_KEY },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const check = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO_KEY_CHECK },
        base,
        256,
      ),
    );
    const identity = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO_AUDIT_IDENTITY },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    const cacheId = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO_QUERY_CACHE_ID },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign'],
    );
    const cacheData = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: INFO_QUERY_CACHE_DATA },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return { aes, check, identity, cacheId, cacheData };
  } finally {
    masterKey.fill(0);
  }
}

/**
 * AAD for a stored NR key: `u32 len || purpose || u32 len || credential id (UTF-8) || u32 key version`.
 * Length prefixes make the encoding injective, so no (id, version) pair can collide with another.
 */
export function credentialAad(credentialId: string, keyVersion: number): Uint8Array<ArrayBuffer> {
  const id = utf8(credentialId);
  return concatBytes(
    u32(CREDENTIAL_AAD_PURPOSE.byteLength),
    CREDENTIAL_AAD_PURPOSE,
    u32(id.byteLength),
    id,
    u32(keyVersion),
  );
}

/** AES-256-GCM, 128-bit tag. Returns `ciphertext || tag` (the WebCrypto layout). Internal. */
export async function seal(
  key: WebCryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext),
  );
}

/** Inverse of `seal`; throws WebCrypto's `OperationError` when authentication fails. Internal. */
export async function open(
  key: WebCryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
  sealed: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, sealed),
  );
}

function checkCredentialId(credentialId: string): void {
  if (typeof credentialId !== 'string' || credentialId === '') {
    throw new CryptoError('invalid_input', 'credential id must be a non-empty string');
  }
  if (utf8(credentialId).byteLength > MAX_CREDENTIAL_ID_BYTES) {
    throw new CryptoError('invalid_input', `credential id longer than ${MAX_CREDENTIAL_ID_BYTES} bytes`);
  }
}

/** Copy into a fresh, exactly-sized ArrayBuffer (WebCrypto wants `BufferSource`; storage may hand us views). */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

/**
 * The master keys this process holds, by version: the current one (encrypts) and, during rotation, the previous one
 * (decrypts only). Holds non-extractable `CryptoKey`s and key check values, never raw master keys. Not serialisable:
 * `JSON.stringify` and `util.inspect` print only the versions.
 */
export class Keyring {
  readonly currentVersion: number;
  /** Every version this keyring can decrypt, newest first. */
  readonly versions: readonly number[];
  readonly #keys: ReadonlyMap<number, VersionKeys>;

  private constructor(currentVersion: number, keys: ReadonlyMap<number, VersionKeys>) {
    this.currentVersion = currentVersion;
    this.versions = Object.freeze([...keys.keys()].sort((a, b) => b - a));
    this.#keys = keys;
    Object.defineProperty(this, INSPECT_CUSTOM, { value: () => this.toJSON(), enumerable: false });
    Object.freeze(this);
  }

  /**
   * Build a keyring from master key strings (`[v<N>:]<base64>`). `previous`, if given, must have a lower version
   * and different bytes. Names are only used in error messages.
   */
  static async create(options: {
    readonly current: string;
    readonly previous?: string;
    readonly currentName?: string;
    readonly previousName?: string;
  }): Promise<Keyring> {
    const currentName = options.currentName ?? 'RB_MASTER_KEY';
    const previousName = options.previousName ?? 'RB_MASTER_KEY_PREVIOUS';
    const cur = parseMasterKey(options.current, currentName);
    let prev: ParsedMasterKey | undefined;
    try {
      prev = options.previous === undefined ? undefined : parseMasterKey(options.previous, previousName);
    } catch (error) {
      cur.bytes.fill(0);
      throw error;
    }
    if (prev !== undefined && prev.version >= cur.version) {
      cur.bytes.fill(0);
      prev.bytes.fill(0);
      throw new CryptoError(
        'master_key_invalid',
        `${previousName} has version ${prev.version}, which must be lower than ${currentName}'s version ${cur.version}`,
        'Write the new key as `v<N>:<base64>` with N above the previous version (`relic-bridge keys generate --key-version <N>`).',
      );
    }
    const keys = new Map<number, VersionKeys>();
    let current: VersionKeys;
    try {
      current = await deriveVersionKeys(cur.bytes);
    } catch (error) {
      prev?.bytes.fill(0);
      throw error;
    }
    keys.set(cur.version, current);
    if (prev !== undefined) {
      const p = await deriveVersionKeys(prev.bytes);
      if (timingSafeEqual(p.check, current.check)) {
        throw new CryptoError(
          'master_key_invalid',
          `${currentName} and ${previousName} are the same key`,
          'Generate a new key for the new version with `relic-bridge keys generate --key-version <N>`.',
        );
      }
      keys.set(prev.version, p);
    }
    return new Keyring(cur.version, keys);
  }

  has(version: number): boolean {
    return this.#keys.has(version);
  }

  /** Key check value for a version (non-secret: a one-way HKDF output). */
  keyCheckValue(version: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.#need(version).check);
  }

  /**
   * Encrypt an NR key for credential `credentialId` under the current version: fresh random 96-bit IV, AAD binding
   * the ciphertext to the credential id and the version.
   */
  async encryptCredentialKey(credentialId: string, plaintext: string): Promise<EncryptedKey> {
    checkCredentialId(credentialId);
    if (typeof plaintext !== 'string' || plaintext === '') {
      throw new CryptoError('invalid_input', 'nothing to encrypt');
    }
    // A lone surrogate would be silently replaced by U+FFFD on encoding, so the stored key would not be the one given.
    if (LONE_SURROGATE_RE.test(plaintext)) {
      throw new CryptoError('invalid_input', 'plaintext is not well-formed Unicode');
    }
    const bytes = utf8(plaintext);
    try {
      if (bytes.byteLength > MAX_PLAINTEXT_BYTES) {
        throw new CryptoError('invalid_input', `plaintext longer than ${MAX_PLAINTEXT_BYTES} bytes`);
      }
      const version = this.currentVersion;
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const ciphertext = await seal(this.#need(version).aes, iv, credentialAad(credentialId, version), bytes);
      return Object.freeze({ kind: 'encrypted' as const, ciphertext, iv, keyVersion: version });
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * Decrypt the NR key stored on credential `credentialId`. Fails with `decrypt_failed` if the ciphertext, IV or
   * tag was altered, belongs to another credential, or is labelled with another version; with
   * `key_version_unknown` if this keyring has no key for its version.
   */
  async decryptCredentialKey(credentialId: string, key: EncryptedKey): Promise<Secret> {
    checkCredentialId(credentialId);
    if (key === null || typeof key !== 'object' || key.kind !== 'encrypted') {
      throw new CryptoError('invalid_input', `credential ${credentialId} has no encrypted key`);
    }
    if (!(key.iv instanceof Uint8Array) || key.iv.byteLength !== IV_BYTES) {
      throw new CryptoError('decrypt_failed', `credential ${credentialId}: IV must be ${IV_BYTES} bytes`);
    }
    if (!(key.ciphertext instanceof Uint8Array) || key.ciphertext.byteLength <= TAG_BYTES) {
      throw new CryptoError('decrypt_failed', `credential ${credentialId}: ciphertext too short`);
    }
    const keys = this.#need(key.keyVersion, credentialId);
    let plain: Uint8Array<ArrayBuffer>;
    try {
      plain = await open(
        keys.aes,
        own(key.iv),
        credentialAad(credentialId, key.keyVersion),
        own(key.ciphertext),
      );
    } catch {
      throw new CryptoError(
        'decrypt_failed',
        `credential ${credentialId} could not be decrypted with master key version ${key.keyVersion}`,
        'Wrong master key for this version, or the stored row was altered or copied from another credential.',
      );
    }
    try {
      return new Secret(fromUtf8(plain));
    } catch {
      throw new CryptoError('decrypt_failed', `credential ${credentialId}: decrypted key is not valid UTF-8`);
    } finally {
      plain.fill(0);
    }
  }

  /**
   * Keyed hash of a sign-in identity for the audit log (P4-16, THREAT_MODEL T8/T14): `v<N>.<base64url>` of the first
   * 128 bits of HMAC-SHA-256 over the length-prefixed `(idp, subject)` under the current master key version. Equal
   * identities hash equally under one version, so repeated probes correlate; without the master key a hash cannot be
   * tested against a guessed subject (an unkeyed hash of a known email could). Rotating the master key changes every
   * hash: the version prefix says which ones compare.
   */
  async identityHash(idp: string, subject: string): Promise<string> {
    const a = utf8(idp);
    const b = utf8(subject);
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        this.#need(this.currentVersion).identity,
        concatBytes(u32(a.byteLength), a, u32(b.byteLength), b),
      ),
    );
    const b64 = toBase64(mac.subarray(0, IDENTITY_HASH_BYTES));
    return `v${this.currentVersion}.${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  }

  /**
   * Keys for the NRQL query cache (P7-02) under the current master key version: `id` signs entry ids, `data`
   * encrypts bodies kept in the shared Workers Cache API. Rotating the master key starts a fresh cache.
   */
  queryCacheKeys(): { readonly id: WebCryptoKey; readonly data: WebCryptoKey } {
    const keys = this.#need(this.currentVersion);
    return Object.freeze({ id: keys.cacheId, data: keys.cacheData });
  }

  toJSON(): { currentVersion: number; versions: readonly number[]; keys: string } {
    return { currentVersion: this.currentVersion, versions: this.versions, keys: REDACTED };
  }

  toString(): string {
    return `Keyring(v${this.currentVersion})`;
  }

  #need(version: number, credentialId?: string): VersionKeys {
    const keys = Number.isInteger(version) ? this.#keys.get(version) : undefined;
    if (keys === undefined) {
      throw new CryptoError(
        'key_version_unknown',
        `master key version ${String(version)} is not loaded${credentialId === undefined ? '' : ` (needed by credential ${credentialId})`}`,
        `Loaded versions: ${this.versions.join(', ')}. While rotating, set RB_MASTER_KEY_PREVIOUS to the older key.`,
      );
    }
    return keys;
  }
}
