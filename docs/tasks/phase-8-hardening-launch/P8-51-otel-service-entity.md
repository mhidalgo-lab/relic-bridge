---
id: P8-51
title: Self-monitoring spans - service entity golden metrics and per-tool span names
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-51 — Self-monitoring spans: service entity golden metrics and per-tool span names

## Goal
In New Relic the `relic-bridge` service entity (EXT/SERVICE) shows no Error rate or Response time and a Throughput of 0,
although spans arrive (server kind, status set). The resource only has `service.name`, `service.version` and
`process.runtime.name`. Errors Inbox groups are all named `tools/call`, so they can't be told apart.

## Scope
- Add recommended resource attributes: `telemetry.sdk.name`, `telemetry.sdk.language`, `telemetry.sdk.version`,
  `service.instance.id` (random per process/isolate, not derived from host or user data).
- Name spans `tools/call <tool>` (MCP semantic-convention style), tool name from the allowlist (`other` otherwise);
  add the MCP/RPC span attributes New Relic needs for service golden metrics if the resource change is not enough.
  Record what New Relic requires in RESEARCH.md with sources.
- Verify against a live account that golden metrics populate.

## Acceptance criteria
- [x] Resource and span attributes added, each pattern-checked (tests).
- [ ] Live check: entity golden metrics show throughput, response time and error rate.
- [x] Error groups are distinct per tool.

## Security notes
T30: tool names stay allowlisted; `service.instance.id` is random and carries no host or user data.

## Docs to update
- `docs/guide/observability.md`, `docs/RESEARCH.md`, `docs/THREAT_MODEL.md` (T30), changeset.

## Out of scope
- Log records (P8-50), alert and dashboard recipes (P8-52).
