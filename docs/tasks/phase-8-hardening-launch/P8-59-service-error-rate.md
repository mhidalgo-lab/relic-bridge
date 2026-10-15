---
id: P8-59
title: Self-monitoring errors - the service error rate counts real server errors
phase: 8
status: done
priority: high
depends_on: [P8-51]
adr: []
owner: claude-agent
---

# P8-59 — Self-monitoring errors: the service error rate counts real server errors

## Goal
On a live 0.9.1 export (2026-10-14, 24 h) `rpc.server.duration` carries `error.type` (`RB_QUERY_NOT_FOUND`,
`RB_LIMIT_QUERY`) on failed calls, yet `sum(apm.service.error.count)` is 0 and the entity's golden Error rate stays 0,
while throughput and response time populate. New Relic only counts an `rpc.server.duration` data point as an error when
`rpc.grpc.status_code` is one of 2, 4, 12, 13, 14, 15. At the same time every error in the window was caused by the
caller (`RB_INPUT_INVALID`, `RB_LIMIT_QUERY`, `RB_QUERY_NOT_FOUND`), yet each span had status ERROR and opened an
unresolved Errors Inbox group. The error rate should show failures of relic-bridge or New Relic, not callers' mistakes.

## Scope
- Classify every `RB_*` error code as a caller error or a server error (table in the guide, with the reasons).
- Server errors: span status ERROR, `error.type` on the span and on `rpc.server.duration`, and a value New Relic counts
  in `apm.service.error.count`.
- Caller errors: span status Unset, no `error.type`; keep `status=error` and `error.code` (and add the
  classification) so they can still be counted.
- Choose and implement how New Relic counts server errors; record the decision and the alternatives.
- RESEARCH.md: close the P8-51 open question with the evidence and sources. THREAT_MODEL T30 for the new exported values.

## Acceptance criteria
- [x] Every `ErrorCode` has a classification (type-checked, tested), unknown codes count as server errors.
- [x] Server errors: span status ERROR, `error.type`, `rpc.grpc.status_code` on `rpc.server.duration` (tests).
- [x] Caller errors: span status Unset, no `error.type` and no `rpc.grpc.status_code`, `error.code` and the
      classification kept (tests).
- [x] Guide documents the classification, the attributes and the deliberate `rpc.grpc.status_code` deviation.
- [ ] Live check: after a deploy, the entity's Error rate and `apm.service.error.count` count server errors only.
      Not ticked: needs a release and a deploy; the NRQL to check is in the PR.

## Security notes
T30: the new attribute values come from fixed tables (`caller`/`server`, a small set of integer status codes keyed by
the already pattern-checked error code); nothing from the request reaches them.

## Docs to update
- `docs/guide/observability.md`, `docs/RESEARCH.md`, `docs/THREAT_MODEL.md` (T30), changeset.

## Out of scope
- Alert conditions and a dashboard (P8-52). The access log's `mcpMethod = other` (P8-61).
