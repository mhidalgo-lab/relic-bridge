---
id: P8-90
title: Self-telemetry - error status on spans, logs in context, spans for every MCP method
phase: 8
status: todo
priority: medium
depends_on: []
adr: []
owner: ""
---

# P8-90 — Self-telemetry: error status on spans, logs in context, spans for every MCP method

## Goal
Review 4 (NEW-27) read relic-bridge's own OTLP data in New Relic:
- error spans keep `otel.status_code` unset and carry no `error.type`, so the service error rate stays at 0
- log records have no `trace.id` / `span.id`
- only `tools/call` is traced; `initialize`, `tools/list`, `prompts/get`, `resources/read` and `tasks/*` produce no
  spans
- the write outcome and the elicitation round aren't recorded

## Scope
- Failed tool calls: span status `ERROR`, `error.type` set to the `RB_*` code, consistent with the P8-59 metric rules
  (caller errors versus server errors; keep `rpc.grpc.status_code` only on server errors).
- One span per MCP request for every method (`rpc.method`), with the same attributes as tool spans where they apply.
- Log records emitted inside a span carry `trace.id` and `span.id` (OTLP `traceId` / `spanId` fields), on both Node and
  Workers.
- Write spans: `write.applied`, `write.confirmation`, and `elicitation.result` (`accepted | declined | cancelled |
  unavailable`). Coordinate with P8-88: whichever lands second uses the other's helper.
- Never put arguments, NRQL text, keys or tokens on spans or logs (existing redaction rules).

## Acceptance criteria
- [ ] Tests: a tool error gives span status ERROR plus `error.type`; a caller error doesn't set
      `rpc.grpc.status_code`.
- [ ] Tests: a `resources/read` and a `prompts/get` each produce one span.
- [ ] Tests: a log line inside a tool call carries the span's trace and span ids (Node and the Workers runtime test).
- [ ] `docs/guide/observability.md` and `docs/security/logging.md` list the new attributes.

## Security notes
T8 (no secrets in telemetry). The logging inventory (`docs/security/logging.md`) must stay accurate.

## Docs to update
- `docs/guide/observability.md`, `docs/security/logging.md`, self-monitoring recipes if a query changes, changeset
  (minor).

## Out of scope
- New metrics.
