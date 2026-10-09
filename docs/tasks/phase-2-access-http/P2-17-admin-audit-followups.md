---
id: P2-17
title: Admin API audit and error-model follow-ups
phase: 2
status: review
priority: medium
depends_on: [P2-09]
adr: [0009]
owner: claude-agent
---

# P2-17 — Admin API audit and error-model follow-ups

Found by the Phase 2 consolidation review (`docs/reviews/phase-2-review.md`, M2/L3). The admin API is sound, but
two claims in the docs and the threat model are stronger than the code.

## Goal
Every refused admin change is audited, and a storage outage looks like an outage (503), not a bug (500).

## Scope
- Requests refused by schema validation (`defaultHook` in `packages/http-app/src/admin/api.ts`) on mutating routes
  write an `admin` audit row (`status: error`, `errorCode: invalid_request`, action from the route, no submitted values
  in `details`), through the same capped writer as other refusals so a flood can't fill the table.
- `StorageError` (and adapter busy/locked errors) map to `503 unavailable` with `Retry-After` in
  `packages/http-app/src/admin/errors.ts`, like the MCP route.
- Body-less actions (`POST /tokens/{id}/revoke`, `/grants/{id}/revoke`, `/credentials/{id}/revalidate`) accept a
  request without `Content-Type` (today `curl -X POST` gets `415`).
- The `token.create` audit row records the effective TTL (today `ttlSeconds: null` when the default applied).
- The P2-12 matrix positive control asserts the expected success status (200), not just "not 401/403".
- Reword `docs/reference/admin-api.md` ("never echo submitted values": 404 and unknown-field messages echo redacted,
  truncated ids and field names) and the P2-09 row of `docs/THREAT_MODEL.md` to match.

## Acceptance criteria
- [x] Test: an invalid body on each mutating route writes exactly one `admin` row with `invalid_request`, no body values.
- [x] Test: a storage adapter that throws gives `503` with `Retry-After` on a read and on a change.
- [x] P2-12 authz matrix still green; docs updated.

## Security notes
T14/T17 (admin actions audited), T20 (refusal rows capped). No new route.

## Docs to update
- `docs/reference/admin-api.md`, `docs/THREAT_MODEL.md` (P2-09 row), `docs/guide/audit-log.md`.

## Out of scope
- Per-user admin identities (P4-01/P4-02).
