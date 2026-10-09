---
id: P4-16
title: "Bind identities atomically and keep at least one owner"
phase: 4
status: review
priority: medium
depends_on: [P4-01, P4-09]
adr: []
owner: claude-agent
---

# P4-16 — Bind identities atomically and keep at least one owner

## Goal
Close three identity gaps found by the Phase 4 consolidation review (`docs/reviews/phase-4-review.md` L1, L4, I2):
a racy first-login binding, no last-owner guard, and `login.denied` rows that cannot be traced to an identity.

## Scope
- **Compare-and-set binding.** `resolveLoginUser` (`packages/auth/src/identity/policy.ts`) reads the user by email and
  then updates `(idp, idp_subject)` by id. Two concurrent first sign-ins at two configured providers for the same unbound
  email both succeed and both get sessions (last writer keeps the binding). Add `users.bind(id, idp, subject)` to the
  three adapters (`UPDATE … WHERE id = ? AND idp IS NULL AND idp_subject IS NULL RETURNING *`) and map "no row" to
  `identity_conflict`.
- **Last owner.** `PATCH /users/{id}` (role or disable) and the CLI refuse to leave zero enabled owners (two owners
  demoting each other concurrently today can). Count inside the same storage call or re-check after the write and undo.
- **Forensics.** `login.denied` rows carry provider and reason only. Add a keyed hash of `(idp, subject)` (HMAC with a
  key derived from the master key, never the raw subject or email) so repeated `identity_conflict` / `not_allowed`
  probes from one identity can be correlated. Audit the previous role when a setup link promotes an existing user.

## Acceptance criteria
- [x] A `Promise.all` of two first sign-ins (different providers, same unbound email) gives one `ok` and one
      `identity_conflict`, on memory, SQLite and D1 (workers pool).
      (`packages/auth/test/login-race.ts`, run from `packages/auth/test/identity.test.ts`, `apps/cli/test/login-race.test.ts`
      (one connection and two connections to one file) and `apps/worker/test/d1.test.ts`; `bind` contract tests incl. a
      concurrent race in `packages/storage/src/testing.ts`.)
- [x] Demoting or disabling the last enabled owner answers `409` (API, UI form, CLI); concurrent demotions leave one owner.
      (`packages/http-app/test/authz/last-owner.test.ts` on Node and in workerd; storage contract race on all three
      adapters; `last_owner` flash in `packages/admin-ui/test/screens.test.ts`. The CLI has no role or disable command
      (P2-10 left it to the Admin API); every CLI path goes through the same admin handlers and storage guard, and an
      API refusal prints `... [last_owner]`. See pending decisions.)
- [x] `login.denied` rows carry the keyed identity hash; no email or subject appears in audit, logs or responses (T8 scan).
      (`details.identityHash`, also on `login.ok`; KAT pinned in `packages/auth/test/kat.test.ts`; scan in
      `packages/http-app/test/identity.test.ts`. `previousRole` on an `owner_bootstrap` of an existing user.)
- [x] THREAT_MODEL T14 updated.

## Implementation notes
- `UsersRepository.bind(id, idp, subject, patch)`: one conditional `UPDATE … WHERE id = ? AND idp IS NULL AND
  idp_subject IS NULL AND disabled_at IS NULL` (SQL in `packages/storage/src/user-guards.ts`, `RETURNING` on D1).
  `null` → `identity_conflict`; a duplicate identity is a `ConflictError` (already mapped to `identity_conflict`).
- Last owner: every `users.update` carries `lastOwnerGuardSql` in its `WHERE` (enabled owner → may lose that state only
  while another enabled owner `EXISTS`); a refused write is `ConflictError('users.last_owner')` →
  `409 conflict`, `detail: last_owner`. No schema change, so no migration.
- Identity hash: `Keyring.identityHash` (HKDF info `relic-bridge/audit-identity/hmac-sha-256`, HMAC-SHA-256, 128 bits,
  `v<N>.<base64url>`), passed to the sign-in routes by `createHttpApp`; a hash failure logs a warning and the row is
  written without it.

## Security notes
T14 (account takeover via binding), T8 (no identifiers in logs). The hash must be keyed: an unkeyed hash of an email is
reversible by dictionary.

## Docs to update
- `docs/guide/admin-access.md` (roles: last owner), `docs/guide/audit-log.md` (`login.denied` fields), THREAT_MODEL.

## Out of scope
- Email-based linking across providers (pending decision P4-01).
