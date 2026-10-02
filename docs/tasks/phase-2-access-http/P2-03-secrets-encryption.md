---
id: P2-03
title: Secrets encryption and master-key rotation
phase: 2
status: todo
priority: high
depends_on: [P2-01]
adr: [0007]
owner: ""
---

# P2-03 — Secrets encryption and master-key rotation

## Scope
- `packages/auth/crypto`: AES-256-GCM encrypt/decrypt with AAD (`credential_id || key_version`), random 96-bit IV, versioned keyring from `RB_MASTER_KEY` (+ `RB_MASTER_KEY_PREVIOUS` during rotation).
- `relic-bridge keys generate` (prints new key once) and `relic-bridge keys rotate`.
- Boot check: refuse to start in remote modes without a valid 32-byte master key.

## Acceptance criteria
- [ ] Tests: round trip; tampered ciphertext fails; swapped row (other credential id) fails; rotation re-encrypts all rows.
- [ ] Known-answer test vectors.

## Security notes
T7. Needs second reviewer.

## Docs to update
- `docs/guide/secrets.md` (backup the master key!), THREAT_MODEL.

## Out of scope
- OS keychain (P7-11).
