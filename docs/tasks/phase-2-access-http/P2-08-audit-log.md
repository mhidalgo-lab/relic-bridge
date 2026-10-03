---
id: P2-08
title: Audit log
phase: 2
status: in-progress
priority: high
depends_on: [P2-06]
adr: []
owner: claude-agent
---

# P2-08 — Audit log

## Scope
- **Storage**: `audit_log` already exists (P2-01). One forward-only migration adds kind `auth` (refusals where no tool ran),
  mirrored in types, schema, contract suite and both adapters. No other schema change.
- **`AuditRecorder`** in `@relic-bridge/http-app` (web-standard): `toolCall`, `denied` (auth failure, rate limit, tool not
  granted) and `admin` (the API P2-09/P2-10 call: actor, action, target, non-secret details). It exposes `hooks`
  (composed with rate limiting via `mergeHooks`). Every write is a background task: a failed write is logged and never
  changes a response.
- **Hook points**: `buildMcpServer` gets an optional `onToolCall` (tool, status, error code, duration, result metadata);
  `HttpAppHooks` gets `onToolCall` and `onRejected` (a `beforeAuth`/`beforeMcp` refusal such as a 429). Per tool call:
  ts, user, grant, token, project, tool, accounts, status, error code, duration, inspected count, NRQL.
- **NRQL**: `RB_AUDIT_NRQL=mask` (default: string/number literals replaced by `?`, keywords, identifiers and the time
  window kept, then redacted and truncated), `hash` (SHA-256 of the masked shape), `full` (redacted, truncated), `off`.
- **Privacy / no secrets**: never the token, key, result rows or request body; `details` are redacted, depth- and
  size-bounded; pre-authentication refusals carry the client IP (configurable off) and are capped per minute so an
  unauthenticated flood can't fill the table (T20).
- **Retention**: `RB_AUDIT_RETENTION_DAYS` (default 90, `0` = keep forever); purge at startup and hourly in `serve`, and
  `relic-bridge audit purge`. `RB_AUDIT=off` disables recording.

## Acceptance criteria
- [ ] Tests: entries written for ok/error/denied tool calls, auth failures and rate limits; masking modes work; a scan
  test finds no secret (token, NR key, fixture literal) in any audit row; write failure leaves the response intact
  and is logged; retention purge; admin API.
- [ ] Contract suite and both adapters accept kind `auth`; migration applies on top of an existing database.
- [ ] `serve` wires it (env, startup + periodic purge); `audit purge` command.

## Security notes
T8, T17, T20. Privacy: document what is stored.

## Docs to update
- `docs/guide/audit-log.md`, THREAT_MODEL (open question resolved, T17), ARCHITECTURE (request flow, data model),
  self-hosting guide, pending decisions.

## Out of scope
- Viewer UI (P4-05); audit query REST endpoint (P2-09); tamper-evident hash chaining (new task if wanted).
