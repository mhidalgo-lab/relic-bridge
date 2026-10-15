---
id: P8-71
title: Cryptographic inventory (ASVS 5.0 V11)
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-71 — Cryptographic inventory (ASVS 5.0 V11)

## Goal
ASVS 5.0 chapter V11 asks for a documented inventory of cryptographic keys, algorithms and their lifecycle. The facts are
spread over ADRs, code comments and the threat model. One reviewable document lets an auditor (and the OpenSSF badge
answers) check them in one place and lets us notice a primitive that should change.

## Scope
`docs/security/cryptography.md`, one table per category, each row with: purpose, algorithm and parameters, key or secret
source, where it is used (file), where it is stored and in what form, lifetime and rotation, what happens on compromise.
Verify every row against the code; do not copy from comments. At least:
- Master key and keyring (`packages/auth/src/crypto/keyring.ts`, `rotate.ts`): 32 random bytes `v<N>:<base64>`, HKDF-SHA-256
  with fixed salt and per-purpose `info` labels, AES-256-GCM data key for New Relic keys, HMAC-SHA-256 keys (audit identity
  hashes, query-cache ids), AES-GCM for cached bodies on Workers; key check values; rotation (`keys rotate`,
  `RB_MASTER_KEY_PREVIOUS`).
- Access tokens (`packages/auth/src/tokens`): `rb_<env>_<secret>_<checksum>`, secret entropy, CRC-32 checksum (typo
  detection only, not security), the stored hash (`hashToken`), display prefix, expiry and revocation.
- Sessions and CSRF tokens (`packages/auth/src/identity/session.ts`, `login.ts`): random values, hashing at rest, cookie
  attributes, timeouts.
- Sign-in flows (`packages/auth/src/identity`): state, nonce, PKCE, JWT verification algorithms accepted, JWKS caching.
- OAuth server (`packages/http-app/src/oauth`): authorization codes, refresh tokens and their SHA-256 markers, PKCE S256,
  client ids, replay protection, what the provider stores in KV/D1 and in what form.
- Config bundle transfer (`packages/auth/src/transfer/seal.ts`): PBKDF2-HMAC-SHA-256 (iterations, 16-byte salt, Worker
  WebCrypto limit), AES-256-GCM with a fresh IV, passphrase handling.
- OTLP self-monitoring (`packages/http-app/src/telemetry.ts`): trace, span and instance ids from `crypto.getRandomValues`;
  `Math.random` is used only for the sampling decision and is not security relevant (say so).
- TLS: what we rely on (proxy, Cloudflare), outbound TLS to NerdGraph and IdPs; no custom certificate handling.
- Random sources: confirm every secret uses WebCrypto (`crypto.getRandomValues` / `randomUUID`) and list any exception.

Also list algorithms deliberately not used and the review date. Link the document from `docs/ARCHITECTURE.md`, the
security guide and the best-practices answers.

## Acceptance criteria
- [x] Every key, KDF, cipher, MAC, hash and random source in the repo appears in the document with a file reference
      (checked by grepping `crypto.subtle`, `getRandomValues`, `randomUUID`, `Math.random` and listing each hit as covered
      or irrelevant).
- [x] Rotation and compromise procedure stated for each long-lived key.
- [x] A test (or script check) that fails when a new `crypto.subtle` algorithm name appears in `packages/*/src` that the
      document does not mention (optional but preferred). `scripts/test/crypto-inventory.test.ts` also covers
      `apps/*/src` and `scripts/*.ts`, `node:crypto` calls and `jose`, and requires every such file to be listed.
- [x] Linked from `docs/ARCHITECTURE.md` and `docs/security/best-practices-answers.md` (and the security guide and the
      ASVS checklist, where V11.1.1 and V11.1.2 move from partial to met).

## Security notes
Documentation only; findings that are real weaknesses become their own tasks (security-relevant ones go through the
private advisory process, not this file).

## Docs to update
- New `docs/security/cryptography.md`, `docs/ARCHITECTURE.md`, `docs/guide/security-basics.md` (link),
  `docs/security/best-practices-answers.md`.

## Out of scope
- Changing any algorithm or parameter.
