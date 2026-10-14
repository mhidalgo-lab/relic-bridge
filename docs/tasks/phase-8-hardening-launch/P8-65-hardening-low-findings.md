---
id: P8-65
title: "Hardening: event-type lists, redirects, subquery windows, remembered consent"
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-65 — Hardening: event-type lists, redirects, subquery windows, remembered consent

## Goal
Close four low-severity hardening gaps found in the P8-01 review, so that each documented control holds in its edge
cases too: event-type lists, outbound requests that carry credentials, the lookback limit, and "don't ask again".

## Scope
- **Event-type lists (T4/T5).** `checkEventTypes` only inspects `FROM`, so a statement without one (`SHOW EVENT TYPES`)
  could list the names of denied types through `run_nrql`. When an allow or deny list is configured, refuse a query
  (or subquery) without a `FROM` clause with an `RB_LIMIT_QUERY` error and a hint. `list_event_types` keeps working: it
  filters the listing against the connection's lists itself.
- **Redirects on credentialed requests (T12/T30).** The NerdGraph request sets no `redirect` option, so a redirect would
  be followed with the `API-Key` header. Use `redirect: 'manual'` and refuse a 3xx (non-retryable error). Check every
  other outbound request that carries a key, token or secret (OTLP export, IdP calls, JWKS, client metadata documents,
  CLI management client) and make sure none follows redirects. Works on Node and Workers.
- **COMPARE WITH in a subquery (T5).** New Relic does not support `COMPARE WITH` (or `TIMESERIES`) in subqueries
  (docs: "Subqueries in NRQL", Limits). Refuse it explicitly instead of ignoring it in the lookback calculation;
  confirm subquery `SINCE` is counted and subquery `UNTIL` cannot widen the window.
- **Remembered consent (T10).** "Don't ask again" is offered to dynamically registered clients, whose identity is
  not verified. Offer and honour it only for client ID metadata-document clients. Remembered approvals already stored
  for dynamic clients are ignored at read time (and deleted when met), and no longer listed.

## Acceptance criteria
- [x] With an event-type allow or deny list, `SHOW EVENT TYPES` and other FROM-less queries/subqueries are refused
      with `RB_LIMIT_QUERY` and a hint; without a list they still run; `list_event_types` still works under a deny list.
- [x] The NerdGraph request uses `redirect: 'manual'`; a 3xx answer is refused without a retry and without following.
- [x] Every other credentialed outbound request is checked and does not follow redirects; tests cover the NerdGraph
      client (unit, plus a real redirecting socket on Node), the OTLP exporter on Node, and the redirect modes in workerd.
- [x] `COMPARE WITH` inside a subquery is refused with a clear error; subquery `SINCE` counts toward the limits.
- [x] The consent page offers "Don't ask again" only to metadata-document clients; a posted `remember=1` from a dynamic
      client is not saved; a stored remembered approval of a dynamic client is not honoured (the page is shown).
- [x] Negative tests for each of the above.
- [x] THREAT_MODEL (T5, T10, T12, T30 and a §5a row) and the guides updated; patch changeset.

## Security notes
Hardening of T4/T5 (query limits), T10 (consent) and T12/T30 (outbound credential handling). No new route or tool.
Found along the way: workerd rejects `redirect: 'error'`, which the OTLP exporter used, so every OTLP export on Workers
failed (the exporter logged it and paused). It now uses `manual`, and the Worker telemetry test builds a real workerd
`Request` from the exporter's options so this cannot come back unnoticed.

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/guide/query-limits.md`, the OAuth/consent guide, `docs/RESEARCH.md` (NRQL subquery
  limits), changeset.

## Out of scope
- Other findings of the P8-01 review.
