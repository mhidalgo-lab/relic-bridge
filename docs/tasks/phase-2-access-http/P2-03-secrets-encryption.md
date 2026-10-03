---
id: P2-03
title: Secrets encryption and master-key rotation
phase: 2
status: review
priority: high
depends_on: [P2-01]
adr: [0007]
owner: "claude-agent"
---

# P2-03 — Secrets encryption and master-key rotation

## Scope
- `packages/auth` (`src/crypto/`, WebCrypto only, runs on Node and Workers):
  - **Master key**: 32 random bytes, base64 (standard or URL-safe). Written `v<N>:<base64>`; a bare base64 value is
    version 1. `parseMasterKey` / `generateMasterKey`. Placeholder-looking keys (all bytes equal) are refused.
  - **Keyring** from `RB_MASTER_KEY` (+ `RB_MASTER_KEY_PREVIOUS` during rotation): `loadKeyringFromEnv` is the boot
    check that `serve` (P2-06) calls in remote modes; missing, malformed, duplicate or out-of-order keys fail with a
    `CryptoError` whose message never contains key material. Per version, an AES-256-GCM data key and a key check
    value are derived with HKDF-SHA-256 (domain-separated `info`); the raw master key is not kept.
  - **Credential cipher**: `encryptCredentialKey` / `decryptCredentialKey`. AES-256-GCM, fresh random 96-bit IV per
    encryption, 128-bit tag, AAD = length-prefixed `purpose || credential_id || key_version`, so a ciphertext copied
    to another row, or relabelled with another key version, fails. Decryption returns a core `Secret`.
  - **Key check values** stored in `settings` (`crypto.key_check.v<N>`), compared in constant time
    (`timingSafeEqual`): a wrong master key for a known version fails fast with `key_mismatch` instead of
    failing on every row.
  - **Rotation**: `rotateCredentialKeys(storage, keyring)` re-encrypts every row that is not on the current version.
    Each row is its own atomic compare-and-swap (`CredentialPatch.ifKey`, new in the storage contract), so a crash
    leaves every row readable (old or new version) and re-running resumes; a row changed concurrently is reported as a
    conflict, never overwritten. Unknown versions are reported, never dropped.
- CLI: `relic-bridge keys generate [--key-version <n>]` (prints a new key once, on stdout) and
  `relic-bridge keys rotate [--db <path>]`. The CLI also reads `RB_MASTER_KEY_FILE` / `RB_MASTER_KEY_PREVIOUS_FILE`
  (refused when group/other can read them, ADR-0007).

## Acceptance criteria
- [x] Tests: round trip; tampered ciphertext / IV / tag fails (every single-bit flip, property test); swapped row
      (other credential id) fails; relabelled key version fails; wrong master key fails.
- [x] Known-answer test vectors: NIST GCM AES-256 vectors through the same WebCrypto path, plus pinned vectors for
      the key derivation, the AAD layout and a full credential ciphertext.
- [x] Property tests: round trip for arbitrary ids and keys; IVs never repeat.
- [x] Master key parsing and env loading: missing / malformed / short / duplicate / previous ≥ current refused, and
      error messages never contain the key.
- [x] Rotation re-encrypts all rows (incl. revoked), is idempotent and resumable after a partial run, reports
      unknown versions and concurrent changes, and verifies key check values first. Runs against memory and SQLite.
- [x] Storage contract: `CredentialPatch.ifKey` compare-and-swap on memory and SQLite.
- [x] CLI `keys generate` / `keys rotate` with tests; no key ever reaches stderr.

## Security notes
T7. Needs second reviewer.

## Docs to update
- `docs/guide/secrets.md` (backup the master key!), THREAT_MODEL, `docs/guide/configuration.md` (env vars),
  `docs/RESEARCH.md` (WebCrypto AES-GCM / HKDF facts).

## Out of scope
- OS keychain (P7-11).
- Calling the boot check from `serve` (P2-06) and encrypting keys on credential creation (P2-09 / P2-10).
- Rotation on D1 from a Worker (Phase 3): the function is storage-agnostic, only the CLI entry point is Node.
