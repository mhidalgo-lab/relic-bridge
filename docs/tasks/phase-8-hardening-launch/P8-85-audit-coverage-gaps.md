---
id: P8-85
title: Audit coverage gaps from the logging inventory
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-85 — Audit coverage gaps from the logging inventory

## Goal
The logging inventory (P8-72, `docs/security/logging.md`) checked the ASVS 5.0 V16.3 event list against the code. A few
security events reach only the stderr log or nothing at all. Record them in the audit log so an owner can answer
"when and why" from the panel.

## Scope
- **OAuth token issuance:** a successful authorization-code exchange and a successful refresh write one audit row each
  (`oauth.token.issue`, `oauth.token.refresh`: user, grant, OAuth client, provider grant id; never a token or code).
  Failures and reuse are already audited.
- **Undecryptable credential:** `credential could not be opened` (`packages/http-app/src/app.ts`) also writes a row
  (`credential.decrypt_failed`, credential id, key version, never key material), rate-limited like refusal rows.
- **Automatic audit purge on `serve`:** the hourly purge in `apps/cli/src/serve.ts` (`purgeAudit`) records
  `audit.purge` with the number of rows removed (`source: schedule`) when it removed any, like the Worker cron and the
  CLI command.
- **Session expiry (optional):** decide whether an idle or absolute session expiry found at read time is worth an
  `auth` row (`session.expired`); if not, document why in `docs/security/logging.md`.

## Acceptance criteria
- [x] Each new row has a test, including that no token, code or key material is stored.
- [x] Row volume is bounded (no new unauthenticated path can write unbounded rows).
- [x] `docs/guide/audit-log.md` lists the new actions; `docs/security/logging.md` coverage table updated.

## Decisions
- **Session expiry:** no `session.expired` row. Expiry is a clock event with no code path; the next request with the lapsed
  cookie already writes `auth.denied` (`session_idle` / `session_expired`). Documented in `docs/security/logging.md`;
  pinned by `session-expiry-audit.test.ts`.
- **Volume:** the three new row kinds use a new `capped` flag on `AdminAuditEvent`: a per-minute cap of its own (default
  120), separate from the refusal cap, with an `admin.suppressed` summary (`details.rows: "capped"`).
- Fields: `oauth.token.issue` / `oauth.token.refresh` (user, grant, client, `tokenId` and `targetId` `oauth_<grant>`,
  project id, `details {project, oauthGrant}`); `credential.decrypt_failed` (`status` error, `errorCode` the crypto
  reason, credential id, `details {project, keyVersion}`); `audit.purge` `source: schedule`.

## Security notes
T17 (repudiation), T20 (audit flooding), T8 (no secrets in rows).

## Docs to update
- `docs/guide/audit-log.md`, `docs/security/logging.md`. `docs/security/asvs-l2.md` is edited by PR #281 (P8-95), so the
  V16.3.1 and V16.3.4 evidence is below and in the PR description; fold it into asvs-l2.md after both merge.

## Out of scope
- Tamper evidence for the audit table (recorded as a design limit, ASVS V16.4.2).

## ASVS evidence
- **V16.3.1 (security events logged: authentication, session, token issuance):** OAuth code exchange and refresh write
  `oauth.token.issue` and `oauth.token.refresh` (`packages/http-app/src/oauth/server.ts`, `checkIssuance`); tests:
  `packages/http-app/test/authz/oauth-lifecycle-suite.ts` ("successful issuance is audited"; memory, SQLite, D1). Session
  expiry is logged as `auth.denied` with `session_idle` / `session_expired`
  (`packages/http-app/test/authz/session-expiry-audit.test.ts`). Retention changes: `serve`'s purge records `audit.purge`
  with `source: schedule` (`apps/cli/test/serve-e2e.test.ts`).
- **V16.3.4 (secret-use failures logged):** an undecryptable credential writes `credential.decrypt_failed` with the
  credential id, project and key version, never key material (`packages/http-app/src/app.ts`;
  `packages/http-app/test/authz/credential-decrypt-audit.test.ts`, which also pins the per-minute cap and the T8 scan).
