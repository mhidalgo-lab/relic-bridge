---
id: P8-110
title: Span status for JSON-RPC errors answered over SSE (legacy path)
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-110 — Span status for JSON-RPC errors answered over SSE (legacy path)

## Goal
0.13.0 retest (2026-10-17), rest of NEW-34 (P8-102): `tasks/list` and `tasks/result` answer `-32601 Method not found` and
their spans record `otel.status_code: OK` with no `fault` or `error.type`. Corrected cause: this is the **legacy session
path** (2025-era `initialize`, then `Mcp-Session-Id`), where the SDK answers a JSON-RPC error as HTTP 200
`text/event-stream` with one `event: message` / `data: {...}`. `rpcErrorOf` only read `application/json`, so the error
was not seen. The 2026-07-28 path answers HTTP 404 JSON and was already correct.

## Scope
- Read the JSON-RPC error of the single response in an SSE answer to a POST (any non-`tools/call` method, any
  JSON-RPC error the SDK returns that way, e.g. an unknown prompt), on both routes and both hosts, from a clone of the
  response, bounded in size and time, never delaying or altering what the client receives. Open-ended streams (GET,
  `subscriptions/listen`) are not read.

## Acceptance criteria
- [x] Test: a legacy-path `tasks/list`, `tasks/result` and unknown `prompts/get` answered over SSE give a span with
      `fault: caller`, `error.type` the JSON-RPC code, status Unset (project route; Worker host too).
- [x] Regression test: a 2026-07-28 `tasks/list` (and `tasks/result`) answered `-32601` gives a span with `fault: caller`,
      `error.type: "-32601"` and no `otel.status_code: OK`.
- [x] The legacy-path tests still pass unchanged.

## Security notes
None (telemetry only; no request data added to spans).

## Docs to update
- Telemetry docs if the rule text changes; changeset (patch).

## Out of scope
- Implementing `tasks/list` or `tasks/result`.

## Findings
- The 2026-07-28 path was verified correct (404 JSON, span Unset, `fault: caller`, `error.type: -32601`) on the project and
  pass-through routes, over a Node socket and in workerd; those regression tests stay.
- On the legacy path the unread SSE answer left the span `ok`. Fixed in `packages/http-app/src/app.ts`: the answer is
  cloned synchronously, the clone is read in the background (the hooks now run after the read, off the request path),
  parsed for the first JSON-RPC response event and cancelled; at most 8 KiB and 5 s.
- Tests: legacy `tasks/list`, `tasks/result` and an unknown `prompts/get` give a span with `fault: caller` and the
  code, status Unset, and the client still receives the full SSE body (`packages/http-app/test/telemetry.test.ts`);
  the Worker host is covered in `apps/worker/test/worker.test.ts`.
