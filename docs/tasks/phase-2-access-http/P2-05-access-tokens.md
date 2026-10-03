---
id: P2-05
title: Access tokens (per device)
phase: 2
status: in-progress
priority: high
depends_on: [P2-04]
adr: [0009]
owner: claude-agent
---

# P2-05 — Access tokens (per device)

## Goal
Give every device its own revocable bearer token bound to one grant (and so to one project), stored only as a hash,
so the HTTP app (P2-06) can authenticate MCP requests and the CLI/admin API (P2-09, P2-10) can issue and revoke them.

## Scope
- `packages/auth/src/tokens` (WebCrypto only, no module state):
  - **Format** `rb_<env>_<secret>_<checksum>`: `env` is 2-4 lowercase letters/digits (default `live`); `secret` is 43
    base62 characters drawn uniformly from `crypto.getRandomValues` by rejection sampling (≥ 256 bits); `checksum`
    is the CRC-32 of `rb_<env>_<secret>` as 6 fixed-width base62 characters. The `rb_` prefix makes leaks detectable
    (gitleaks rule and redaction pattern from P0-04 already match it); the checksum lets a typo or a random string be
    rejected offline, **without a storage read**.
  - **At rest**: SHA-256 of the whole token (lowercase hex, unique index) plus a display prefix = the first 12
    characters (`rb_live_Ab3d`, the schema's limit, ≤ 6 secret characters). The plaintext is returned once, wrapped
    in core's `Secret`, and never stored or logged.
  - `issueAccessToken`: label (device name, 1-100 chars, no control characters), grant must exist and be live
    (not revoked or expired), expiry default **90 days**, any positive TTL, or `'never'` (allowed, with a
    `token_never_expires` warning); warns `token_outlives_grant` when the token would outlive its grant.
  - `verifyAccessToken`: parse + checksum (no I/O) → SHA-256 → `getByHash` → constant-time hash comparison →
    revoked (any `revoked_at`) / expired (`now ≥ expires_at`) → `{ grantId, tokenId, expiresAt }` (the principal for
    `resolveAccess`, and the cap for any cache). Stable deny reasons for logs: `malformed`, `bad_checksum`,
    `unknown`, `revoked`, `expired`. Input longer than the format allows is refused before any work.
  - **`last_used_at`** written at most once per 5 minutes per token (based on the stored value), returned as a
    promise that never rejects so Workers can hand it to `waitUntil`.
  - `revokeAccessToken` (first revocation time wins), `listAccessTokens` (summaries without the hash),
    `bearerToken(header)` (parses `Authorization: Bearer …`).

## Acceptance criteria
- [ ] Tests: create, verify, revoked, expired (boundary `now == expires_at`), bad checksum and malformed tokens
  rejected **without a storage read**.
- [ ] Property tests: generated tokens match the format and the gitleaks/redaction patterns; any single-character
  change is rejected offline; tokens are unique.
- [ ] Storage holds no plaintext (no row field contains the token); errors, `JSON.stringify` and `String()` of the
  issue result never contain it.
- [ ] A storage adapter returning a record whose hash differs from the presented token's is refused (constant-time
  comparison, not trust in the lookup).
- [ ] `last_used_at` throttled to ≤ 1 write / 5 min; a failing write never fails verification.
- [ ] Issue refuses unknown, revoked and expired grants and bad labels/TTLs; `'never'` warns.

## Security notes
T1 (token theft: per-device, revocable, expiring, hashed at rest, redacted), T15 (revocation is read on every
verification; any cache in P2-06 is capped at ≤ 60 s and at `expiresAt`), T19 (one generic answer for every deny
reason is P2-06's job; reasons here are for logs only).

## Docs to update
- Access model guide (tokens and devices section; the full multi-device guide is P2-13); THREAT_MODEL;
  ARCHITECTURE §4 if the token shape changes.

## Out of scope
- HTTP authentication middleware and caching (P2-06), CLI `token create|list|revoke` (P2-10), admin API (P2-09),
  OAuth (Phase 5).
