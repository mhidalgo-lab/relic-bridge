---
id: P8-50
title: Self-monitoring logs - stream deadlines, access-log fields, documented names
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-50 — Self-monitoring logs: stream deadlines, access-log fields, documented names

## Goal
Observability check of the personal deployment (0.9.0, 2026-10-14):
- About 60 `mcp request timed out` WARN lines per hour, each at exactly the 180 s deadline, while only 13 tool calls
  failed in 7 days. Most likely open GET (SSE) streams that reach the deadline, which is normal, logged as a timeout.
- The ~2,300 exported `http request` lines carry only `ms`: `status` is a number and the allowlist accepts strings only;
  `method` and `route` are not allowlisted. 4xx/5xx can't be counted from New Relic.
- `docs/guide/observability.md` lists `log.tool`, `log.ms`, `log.code`; in New Relic the keys appear as `tool`, `ms`,
  `code`.

## Scope
- Confirm what the timed-out requests are (method, MCP method). If they are GET streams, end them with a distinct
  message at `info` (e.g. `mcp stream closed at deadline`) and keep `mcp request timed out` WARN for real request
  timeouts.
- Export the HTTP status code (integer), method (fixed set) and route (fixed set of route patterns) on access-log
  records; still pattern-checked, never the raw path.
- Find out why the `log.` prefix is missing in New Relic (exporter or ingest) and make the docs match reality.

## Acceptance criteria
- [x] GET stream deadline no longer logs WARN; a real timeout still does (tests).
- [x] Access-log records export status, method and route; unknown values become `other` (tests).
- [x] Observability guide attribute names match what New Relic shows (checked against a live export).

## Findings
- A standalone `GET` is answered 405 by the stateless handler, so the 180 s warnings are not GET streams in this server;
  the exact source is unconfirmed (see `docs/RESEARCH.md`). Open-ended streams (GET, `subscriptions/listen`) now log
  info; anything else at the deadline still warns, now with `route`/`status` fields to investigate.
- The `log.` prefix is dropped by New Relic (observed); the cause is undocumented. The guide lists the observed names.

## Security notes
T30: new attributes are fixed-set or numeric; no path, query string, id or user data is exported.

## Docs to update
- `docs/guide/observability.md`, `docs/THREAT_MODEL.md` (T30 attribute list), changeset.

## Out of scope
- Span and resource attributes (P8-51).
