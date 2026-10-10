---
id: P7-08
title: "Self-monitoring via OpenTelemetry (opt-in)"
phase: 7
status: done
priority: low
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-08 — Self-monitoring via OpenTelemetry (opt-in)

## Scope
- OTLP/HTTP JSON export (a small `fetch`-based exporter in `packages/http-app/src/telemetry.ts`, web-standard per ADR-0004,
  no OpenTelemetry SDK dependency) of **traces** (one span per tool call, sampled) and **metrics** (tool call count, tool
  duration histogram, refused requests by reason) to the New Relic OTLP endpoint or any collector.
- Wired as HTTP hooks (`onToolCall`, `onPassthroughToolCall`, `onRejected`) in both hosts: Node `serve` and the Worker
  (exported through `waitUntil`). Off by default: `RB_OTEL=on` plus `RB_OTEL_ENDPOINT`; headers (license key) in the secret
  `RB_OTEL_HEADERS`; `RB_OTEL_SAMPLE` for traces.
- Payload is an allowlist with pattern-validated values; no NRQL text (masked or not), arguments, results, ids of people,
  emails, IPs or credentials. Exporter failures never affect a request (timeout, in-flight cap, pause after failure).
- Guide `docs/guide/observability.md`; threat T30.

## Acceptance criteria
- [x] Off by default; documented attributes (`docs/guide/observability.md`).
- [x] Works on Workers (fetch exporter, `waitUntil`) and Node; tests against a mock OTLP receiver (in-process and a real local socket).
- [x] T8/T30 redaction tests: no NRQL literal, email, NR key, token or license key in any exported byte or log line; hostile tool names and error codes become `other`.
- [x] A failing, slow or erroring collector never fails or delays a request; logs name the error class only.
- [x] Endpoint and headers only from env/secrets, https enforced (loopback excepted), never logged.
- [x] Trace sampling; bundle size and `pnpm bench:cpu` unchanged in practice (no dependency, hooks only when on).

## Security notes
T8: exporter redaction tests. T30: data egress to a third party; see `docs/THREAT_MODEL.md`.

## Docs to update
- Observability guide (new), threat model, self-hosting variables, Worker README, ARCHITECTURE.

## Out of scope
- OTLP **logs** signal, budget-usage metrics (the tool call event does not carry the NerdGraph call count), trace-context
  propagation from the client, protobuf encoding, and telemetry for the stdio server: follow-up task P7-18.
