---
id: P7-28
title: "Owner-only edits of write-enabled projects/grants, and audit before the mutation"
phase: 7
status: todo
priority: medium
depends_on: [P7-09]
adr: [ADR-0015]
owner: claude-agent
---

# P7-28 — Owner-only edits of write-enabled scope; audit before the mutation

## Goal
Phase 7 review M5 and L-audit:
- `guardWriteTools` (`packages/http-app/src/admin/api.ts`) blocks a non-owner from **adding** write tool names, but an
  admin can still widen where an already write-enabled project or grant writes (`allowedAccountIds`, `accountIds`,
  `defaultCredentialId`, `rawNrql`, limits).
- The write audit row is written in the background after the mutation (`packages/http-app/src/app.ts`); a failed
  append is only logged, so a write can succeed with no row. `createHttpApp({ writeTools: true })` without an audit
  hook is accepted (only `serve` and the Worker refuse `RB_AUDIT=off`).

## Scope
- Scope-widening edits of a project or grant that names write tools need an owner (or the admin token); tests on the
  authz matrix.
- Write tools: an "intent" audit row awaited before the mutation (or the row awaited after, failing the call's
  response loudly), and `createHttpApp` refusing `writeTools` without an audit hook.
- Write-tool calls skip the access cache (revocation takes effect at once, today up to 30 s per isolate).

## Acceptance criteria
- [ ] Negative authz tests: admin session widening a write-enabled project/grant gets 403.
- [ ] Test: audit store failure means no mutation is sent (or the documented alternative).
- [ ] Test: revoking a write grant blocks the next write immediately.
- [ ] THREAT_MODEL T31 updated.

## Security notes
T31, T14 (audit), T3.

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/guide/admin-guide.md`, ADR-0015 addendum.
