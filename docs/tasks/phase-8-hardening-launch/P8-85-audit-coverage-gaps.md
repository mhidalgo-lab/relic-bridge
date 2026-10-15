---
id: P8-85
title: Audit coverage gaps from the logging inventory
phase: 8
status: todo
priority: low
depends_on: []
adr: []
owner: ""
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
- [ ] Each new row has a test, including that no token, code or key material is stored.
- [ ] Row volume is bounded (no new unauthenticated path can write unbounded rows).
- [ ] `docs/guide/audit-log.md` lists the new actions; `docs/security/logging.md` coverage table updated.

## Security notes
T17 (repudiation), T20 (audit flooding), T8 (no secrets in rows).

## Docs to update
- `docs/guide/audit-log.md`, `docs/security/logging.md`, `docs/security/asvs-l2.md` (V16.3.1, V16.3.4 evidence).

## Out of scope
- Tamper evidence for the audit table (recorded as a design limit, ASVS V16.4.2).
