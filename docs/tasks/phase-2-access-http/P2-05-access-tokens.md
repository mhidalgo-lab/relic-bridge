---
id: P2-05
title: Access tokens (per device)
phase: 2
status: todo
priority: high
depends_on: [P2-04]
adr: [0009]
owner: ""
---

# P2-05 — Access tokens (per device)

## Scope
- Format: `rb_<env?>_<base62 32 bytes>_<crc32 checksum>` — prefix makes leaks detectable (gitleaks rule from P0-04), checksum allows offline validity check.
- Store `prefix` (first 8 chars for display) + SHA-256 hash; show plaintext once.
- Label (device name), expiry (default 90 days, configurable, "never" allowed with warning), revoke, `last_used_at` (write throttled to ≤ 1/5 min to save subrequests).
- Constant-time comparison.

## Acceptance criteria
- [ ] Tests: create, verify, revoked, expired, bad checksum rejected without DB hit.

## Security notes
T1, T15.

## Docs to update
- Access model guide; multi-device guide.

## Out of scope
- OAuth (Phase 5).
