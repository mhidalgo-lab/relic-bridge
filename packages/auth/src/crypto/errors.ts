// SPDX-License-Identifier: Apache-2.0
// Crypto errors (THREAT_MODEL T7, T8). Messages name variables, versions and credential ids only: never key
// material, ciphertext or plaintext, and never the value of the environment variable that failed to parse.

export type CryptoErrorCode =
  /** `RB_MASTER_KEY` (or its file) is not set. */
  | 'master_key_missing'
  /** A master key is not `[v<N>:]<base64 of 32 bytes>`, or looks like a placeholder. */
  | 'master_key_invalid'
  /** The keyring has no key for a ciphertext's version. */
  | 'key_version_unknown'
  /** A master key does not match the key check value registered for its version. */
  | 'key_mismatch'
  /** AES-GCM authentication failed: wrong key, wrong credential id or version (AAD), or tampered data. */
  | 'decrypt_failed'
  /** Bad arguments (empty plaintext, IV of the wrong size, …). */
  | 'invalid_input';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  readonly hint: string | undefined;
  constructor(code: CryptoErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
    this.hint = hint;
  }
}

export function isCryptoError(error: unknown): error is CryptoError {
  return error instanceof CryptoError;
}
