---
id: P8-72
title: Logging inventory (ASVS 5.0 V16)
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-72 — Logging inventory (ASVS 5.0 V16)

## Goal
ASVS 5.0 chapter V16 expects documented logging: what is logged, where it goes, what is protected, how long it is kept and
who can read it. relic-bridge has three sinks (structured stderr logs, the audit log, OTLP export) described in separate
guides. One inventory makes gaps visible.

## Scope
`docs/security/logging.md`, verified against the code:
- **stderr logger** (`packages/core/src/logger.ts`, `redact`/`redactValue`): levels, record shape (`ts`, `level`, `msg`,
  fields), what is redacted and how, the per-request access-log line (`packages/http-app/src/app.ts`: token id, grant id,
  sanitised `Mcp-Method`/`Mcp-Name`, deny reason), boot and warning lines, Worker logs (Cloudflare retention is the
  platform's, link to it).
- **Audit log** (`packages/http-app/src/audit.ts`, `docs/guide/audit-log.md`): every event type and its fields, NRQL privacy
  modes (`RB_AUDIT_NRQL`), client address (`RB_AUDIT_CLIENT_IP`), identity hashes, retention (`RB_AUDIT_RETENTION_DAYS`,
  hourly purge, `audit purge`), who can read it (roles, member self-view), tamper resistance (append-only by API, what an
  operator with database access can still change), what `RB_AUDIT=off` disables.
- **OTLP export** (`packages/http-app/src/telemetry.ts`, `docs/guide/observability.md`): the attribute allowlist per signal,
  pattern checks, what never leaves, destination trust.
- **Events that must be logged** (ASVS V16): authentication successes and failures, access-control refusals, admin changes,
  secret use failures, input validation refusals, boot/config errors; mark each as covered, partial or missing with the sink.
- **What must never be logged:** secrets, tokens, keys, query result data; point to the tests that scan for them.
- Retention, access and deletion per sink; log injection handling (JSON encoding; see also P8-75 for field overwrite).

Gaps found become new task files, not fixes in this PR.

## Acceptance criteria
- [x] Each sink has a section with fields, redaction, retention and readers, each verified against the code.
- [x] A coverage table for the ASVS V16 event list with a "gap" column; every gap links to an existing or new task
      (new: P8-85; existing: P8-75 for the logger field overwrite).
- [x] Linked from `docs/guide/audit-log.md`, `docs/guide/observability.md` and the best-practices answers
      (also ARCHITECTURE and the ASVS checklist, where V16.1.1 and V16.2.3 move from partial to met).

## Security notes
T17 (repudiation), T30 (telemetry egress), T28 (diagnostics leak). Documentation only; do not include real identifiers in
examples.

## Docs to update
- New `docs/security/logging.md`, `docs/guide/audit-log.md`, `docs/guide/observability.md`,
  `docs/security/best-practices-answers.md`.

## Out of scope
- Changing what is logged; adding a log shipper.
