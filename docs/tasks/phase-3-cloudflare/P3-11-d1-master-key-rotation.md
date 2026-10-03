---
id: P3-11
title: Master-key rotation for a D1 database
phase: 3
status: todo
priority: medium
depends_on: [P3-02, P3-05]
adr: [0007]
owner: ""
---

# P3-11 — Master-key rotation for a D1 database

## Goal
Let a Workers deployment rotate `RB_MASTER_KEY` without re-entering every New Relic key. Today `relic-bridge keys
rotate` opens a local SQLite file (`--db`); a Worker's D1 database is not reachable from it, so after setting
`RB_MASTER_KEY_PREVIOUS` the stored credentials stay under the old key version until each is replaced with
`credential rotate`.

## Scope
- Re-encrypt every credential under the current key on D1: a one-shot admin API operation (or the same logic run by the
  Worker's cron trigger), reusing `packages/auth/src/crypto/rotate.ts` and its compare-and-swap.
- A CLI command that calls it with `--remote`; report rows that could not be rotated.
- Update `docs/guide/secrets.md` and `docs/guide/cloudflare-deploy.md` (replace the interim procedure).

## Acceptance criteria
- [ ] A rotation on D1 leaves every row readable at each step and resumes after an interruption.
- [ ] Tests: wrong key, concurrent credential change, authorization (admin token required).

## Security notes
T7, T8. The operation must never return key material and must be admin-only.

## Docs to update
- `docs/guide/secrets.md`, `docs/guide/cloudflare-deploy.md`, `docs/reference/admin-api.md` (generated), THREAT_MODEL.

## Out of scope
- Rotating the New Relic keys themselves.
