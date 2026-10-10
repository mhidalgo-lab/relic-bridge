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

## Update (P2-03): implementation details

Within this decision, P2-03 fixed the details left open:
- The data key is **derived**, not wrapped: HKDF-SHA-256 from the master key (salt `relic-bridge/master-key/v1`,
  info `relic-bridge/credential-key/aes-256-gcm`), non-extractable. A second HKDF output (info
  `relic-bridge/key-check`) is a key check value stored in `settings` per version, to detect a wrong key at boot.
- The version travels with the key: `RB_MASTER_KEY=v<N>:<base64>` (a bare base64 value is version 1), so the process
  knows which version each key is without extra configuration.
- AAD encoding: `u32 len ‖ "relic-bridge/credential-key/v1" ‖ u32 len ‖ credential id (UTF-8) ‖ u32 key version`
  (big-endian lengths, injective).
- Rotation re-encrypts row by row with a storage compare-and-swap instead of one transaction, so it works the same on
  D1 (no interactive transactions) and is resumable.
- On Node the key may also come from `RB_MASTER_KEY_FILE` (must not be group/other-readable).
