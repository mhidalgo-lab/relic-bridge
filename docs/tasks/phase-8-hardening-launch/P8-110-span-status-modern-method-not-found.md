---
id: P8-110
title: Span status for -32601 answers on the 2026-07-28 path
phase: 8
status: review
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-110 — Span status for -32601 answers on the 2026-07-28 path

## Goal
0.13.0 retest (2026-10-17), rest of NEW-34 (P8-102): on the 2026-07-28 request path, `tasks/list` and `tasks/result`
answer `-32601 Method not found` with HTTP 404, and their spans record `otel.status_code: OK` with no `fault` or
`error.type`. The same methods on the legacy path record `fault: caller`, `error.type: -32601`, status unset, which is
the documented rule.

## Scope
- Find where the modern-path `-32601` (HTTP 404) answer bypasses the JSON-RPC error read that sets `fault` and
  `error.type` (see the comment in `packages/http-app/src/app.ts` near line 208 and `telemetry.ts` near line 345), and
  apply the one rule to every JSON-RPC error answer on both paths and both hosts (Node and Worker).

## Acceptance criteria
- [x] Test: a 2026-07-28 `tasks/list` (and `tasks/result`) answered `-32601` gives a span with `fault: caller`,
      `error.type: "-32601"` and no `otel.status_code: OK`.
- [x] The legacy-path tests still pass unchanged.

## Security notes
None (telemetry only; no request data added to spans).

## Docs to update
- Telemetry docs if the rule text changes; changeset (patch).

## Out of scope
- Implementing `tasks/list` or `tasks/result`.

## Findings
Not reproducible on the code of 0.13.0. With the 2026-07-28 envelope, `tasks/list` and `tasks/result` reach the SDK's
own `404` `-32601` (they are not in `TASK_METHODS`, so `serveTasks` does not answer them). The app reads the status and the
JSON-RPC code, and the span is `status: {code: 0}` with `fault: caller`, `error.type: "-32601"` on the project route and
on the pass-through route: in-process, over a real Node socket (`@hono/node-server`) and in workerd. `failed` in
`recordRequest` is true for any HTTP status of 400 or more on its own, so a span with no `fault` would need a hook outcome
below 400. The tests added here pin the rule on both routes and in the Worker host. If live spans still show
`otel.status_code: OK` for these methods, capture the exported OTLP span (status code and attributes) before the collector
maps it: the exporter sends `status.code 0`, which a collector or the UI may render differently from the legacy path.
