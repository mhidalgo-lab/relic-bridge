---
id: P7-18
title: "OTLP follow-ups: logs, budget usage, stdio, trace context"
phase: 7
status: review
priority: low
depends_on: [P7-08]
adr: []
owner: claude-agent
---

# P7-18 — OTLP follow-ups: logs, budget usage, stdio, trace context

## Scope
- Export the redacted structured log as the OTLP logs signal (same allowlist rules as P7-08).
- Budget usage metrics: NerdGraph calls and bytes per tool call (needs the call count on `ToolCallEvent`).
- Telemetry for `relic-bridge stdio` (no HTTP hooks there; wire through `buildServer({ onToolCall })`).
- Accept an incoming `traceparent` so spans join the client's trace (decide privacy implications first).

## Acceptance criteria
- [x] OTLP logs: the redacted log is exported through a second allowlist (`wrapLogger`, `/v1/logs`); tests for dropped fields, hostile messages, buffer bound, no self-feeding.
- [x] Budget usage: `ToolCallEvent.nerdgraphCalls` / `nerdgraphBytes` (counted by the NerdGraph client on the budget), counters and span attributes; tests for numbers, junk values and a real tool call.
- [x] stdio: `RB_OTEL` honoured by `relic-bridge stdio`; test that stdout is untouched and secrets are absent.
- [x] Trace context: strict `traceparent` parsing, opt-in `RB_OTEL_TRACEPARENT`, ignored when off or malformed, never forwarded to NerdGraph (tests). Decision in the pending-decisions log.
- [x] Redaction tests for every new attribute; docs and threat model updated.

## Security notes
T30: every new attribute is allowlisted and pattern-validated.

## Docs to update
- `docs/guide/observability.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Protobuf encoding.
