---
id: P7-18
title: "OTLP follow-ups: logs, budget usage, stdio, trace context"
phase: 7
status: todo
priority: low
depends_on: [P7-08]
adr: []
owner: ""
---

# P7-18 — OTLP follow-ups: logs, budget usage, stdio, trace context

## Scope
- Export the redacted structured log as the OTLP logs signal (same allowlist rules as P7-08).
- Budget usage metrics: NerdGraph calls and bytes per tool call (needs the call count on `ToolCallEvent`).
- Telemetry for `relic-bridge stdio` (no HTTP hooks there; wire through `buildServer({ onToolCall })`).
- Accept an incoming `traceparent` so spans join the client's trace (decide privacy implications first).

## Acceptance criteria
- [ ] Each item above implemented behind the existing `RB_OTEL` switch, or split out; redaction tests for new attributes.

## Security notes
T30: every new attribute is allowlisted and pattern-validated.

## Docs to update
- `docs/guide/observability.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Protobuf encoding.
