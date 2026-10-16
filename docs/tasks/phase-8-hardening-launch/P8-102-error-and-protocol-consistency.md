---
id: P8-102
title: Local error formatting, tasks/* method-not-found, and one span status rule
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-102 — Local error formatting, tasks/* method-not-found, and one span status rule

## Goal
Review 5 (0.12.0) consistency findings:
- **NEW-29:** `RB_INPUT_INVALID` errors raised locally (for example `create_dashboard` with multi-statement NRQL,
  `SELEKT`, unbalanced parentheses) print `Details: {"at":"Page 1 widget 1"}` inside an
  `<untrusted-data source="error details">` block, while `RB_LIMIT_QUERY` and `RB_AUTH_FORBIDDEN` print `Details:`
  plainly.
- **NEW-33:** the tasks extension is no longer advertised, but `tasks/get` and `tasks/cancel` answer HTTP 400 `-32021
  Missing required client capability`; `tasks/list` and `tasks/result` answer `-32601`.
- **NEW-34:** caller faults leave `otel.status_code` unset, but `RB_WRITE_APPROVAL_DECLINED` /
  `RB_WRITE_APPROVAL_UNAVAILABLE` (also `fault: caller`) set `otel.status_code: ERROR`, and a JSON-RPC `-32601` answer is
  recorded as `status: ok`.

## Scope
- Every error raised before New Relic is called uses the local formatter (`localDetails`); only details that came from
  New Relic stay wrapped as untrusted.
- When the tasks extension is not advertised on a transport, every `tasks/*` method answers `-32601 Method not found`.
- One span status rule for every method: `otel.status_code: ERROR` only for server or upstream faults; caller faults
  (including approval refusals and JSON-RPC protocol errors) keep `fault: caller` and `error.type` with the status
  unset. JSON-RPC errors are not recorded as `ok`. Document the rule where the telemetry attributes are documented.

## Acceptance criteria
- [x] Test: local `RB_INPUT_INVALID` details are not wrapped; New Relic details still are.
- [x] Test: `tasks/get`, `tasks/cancel`, `tasks/list`, `tasks/result` answer `-32601` when tasks are not advertised.
- [x] Tests for span status on approval refusals and on a `-32601` answer.

## Security notes
T5: only text that really comes from New Relic may skip the untrusted wrapper; keep it on upstream details.

## Docs to update
- Telemetry docs (span attributes), changeset (patch).

## Out of scope
- Re-enabling the tasks extension.
