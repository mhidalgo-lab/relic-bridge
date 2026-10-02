# 0007 — AES-256-GCM encryption of NR keys

- Status: accepted
- Date: 2026-10-01

## Decision
- NR keys at rest are encrypted with **AES-256-GCM** (WebCrypto) using a data key derived from or wrapped by the
  **master key** `RB_MASTER_KEY` (32 random bytes, base64). On Workers it's a secret; on Node it comes from env or a file
  with `0600` permissions.
- Each ciphertext stores `key_version` and a random 96-bit IV. **AAD = `credential_id || key_version`**, so a ciphertext
  copied onto another row fails to decrypt.
- Master key rotation: `relic-bridge keys rotate` re-encrypts all rows under a new version; old versions are kept
  read-only until the re-encryption finishes.
- Keys are decrypted only in memory for the duration of a request. They're never returned by the admin API (only the
  last 4 characters and the validated NR user email).
- Access tokens are **not** encrypted but hashed (SHA-256). They're high-entropy random values, so a slow KDF isn't
  needed, which also keeps Workers CPU low.

## Consequences
- Losing `RB_MASTER_KEY` means all credentials must be re-entered. Documented prominently, with a backup recommendation.
