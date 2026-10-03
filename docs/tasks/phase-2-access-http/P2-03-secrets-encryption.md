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

## Security review
Second reviewer (independent agent), 2026-10-03. Checked: IV generation (fresh `getRandomValues` per encryption, no
caller-supplied IV), AAD binding (purpose, id and version length-prefixed; swaps and relabels fail), HKDF parameters
(fixed salt is fine for a uniformly random 32-byte IKM; separate `info` for data key and KCV), KCV oracle (one-way,
only confirms a guess of a 256-bit key), master-key parsing (strict canonical base64, length, placeholder, version
range, trim; `*_FILE` follows symlinks on purpose for Kubernetes-style mounts and checks the target's mode), key
material in errors / `JSON.stringify` / `util.inspect` / `toString` (`Secret`, `Keyring`, `CryptoError`), rotation
compare-and-swap on memory and SQLite, web-standard APIs only. Findings, all with regression tests in
`packages/auth/test/security-review.test.ts` (written first, failing before the fix):

| # | Severity | Finding | Fix |
|---|---|---|---|
| SR-1 | Medium | Rollback to a retired master key was accepted: after rotating v1 → v2 (e.g. because v1 leaked), a process started with `RB_MASTER_KEY=v1` passed the boot check and would encrypt new credentials under the retired key. | `verifyKeyChecks` fails with the new code `key_version_retired` when a higher version is registered or used by any row; `rotateCredentialKeys` inherits it. |
| SR-2 | Low | The same master key could be reused under a new version number (`v3:<old v1 bytes>`), silently defeating the rotation. | A loaded key whose KCV equals another version's stored KCV fails with `key_mismatch`. |
| SR-3 | Low | A plaintext with a lone UTF-16 surrogate was silently altered by `TextEncoder` (U+FFFD), so the stored key differed from the one given. | `encryptCredentialKey` refuses non-well-formed strings (`invalid_input`). |
| SR-4 | Low | KCV registration was check-then-set: two processes registering different keys for the same version could both pass. | Values are read back after writing, so at least one side fails with `key_mismatch`. Residual race (no insert-if-absent in `settings`) logged in `docs/pending-decisions/phase-2.md`. |
| — | Info | `Keyring.create` did not zero the previous key's bytes if deriving the current key threw. | Zeroed (best effort; JS gives no hard guarantee). |

Accepted / deferred (pending decisions): replay of an older ciphertext of the *same* credential from a backup while
the previous key is loaded (inherent without per-row freshness; the rotation guide already says to destroy pre-rotation
backups if the old key may have leaked); container secret mounts that are `0444`/`0644` by default are refused by the
`*_FILE` mode check (documented in the secrets guide).

## Docs to update
- `docs/guide/secrets.md` (backup the master key!), THREAT_MODEL, `docs/guide/configuration.md` (env vars),
  `docs/RESEARCH.md` (WebCrypto AES-GCM / HKDF facts).

## Out of scope
- OS keychain (P7-11).
- Calling the boot check from `serve` (P2-06) and encrypting keys on credential creation (P2-09 / P2-10).
- Rotation on D1 from a Worker (Phase 3): the function is storage-agnostic, only the CLI entry point is Node.
