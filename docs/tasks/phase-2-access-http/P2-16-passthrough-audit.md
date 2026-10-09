---
id: P2-16
title: Audit tool calls on the pass-through route
phase: 2
status: todo
priority: low
depends_on: [P2-08, P2-15]
adr: [0008]
owner: ""
---

# P2-16 — Audit tool calls on the pass-through route

Split out of P2-15. Pass-through refusals (`auth.denied`, `request.rejected`) are audited through the existing hooks,
but tool calls on `/passthrough/mcp` are not: `onToolCall` / `afterMcp` take an `McpRequestInfo` (project, grant,
token), which a pass-through request doesn't have.

## Scope
- A hook for pass-through tool calls (e.g. `onPassthroughToolCall(c, info: PassthroughRequestInfo, event)`), merged
  by `mergeHooks`, wired into `createAuditRecorder`.
- Audit row: `kind: tool`, tool name, accounts, outcome, error code, duration, NRQL per `RB_AUDIT_NRQL`, and the
  key's fingerprint id (`pt_…`) as the actor (a new nullable column or `details.keyId`; decide with the storage
  schema). Never the key; the fingerprint id changes across restarts (per-process HMAC secret) unless
  `passthrough.fingerprintSecret` is set.
- `audit tail` / admin API filters can find pass-through rows.

## Acceptance criteria
- [ ] Every pass-through `tools/call` writes one row with the fingerprint id and no key (leak scan).
- [ ] Rows are distinguishable from grant-based rows; the audit query API can filter them.

## Security notes
T8, T17.

## Docs to update
- Audit log guide; self-hosting guide (pass-through section); THREAT_MODEL.
