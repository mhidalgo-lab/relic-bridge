---
id: P8-63
title: "Verification guide: async query handles and write tools"
phase: 8
status: done
priority: low
depends_on: [P8-43]
adr: ["0005", "0015", "0016"]
owner: claude-agent
---

# P8-63 — Verification guide: async query handles and write tools

## Goal
The 0.9.1 verification report could not exercise two areas: the async `get_query_result` path ("no query was slow
enough to return a pending handle") and the four write tools (no sandbox run of the `dry_run` and `confirm`
guarantees). Give the next run written recipes for both, based on the code as it is, without adding a test hook to the
server.

## Scope
- `docs/dev/verification-guide.md` (new): how `run_nrql` reaches a pending handle (async submit with
  `timeout_seconds` down to 1, then up to 3 polls in the same call), the conditions that never return one
  (cross-account, query cache, async unavailable, MCP Tasks clients, `rawNrql: false`), a step-by-step recipe with
  example heavy queries and expected outputs, negative checks for `get_query_result`, and what to record.
- The same page: the HTTP transport is stateless with `tools.listChanged: false` (P2-06, ADR-0005, RESEARCH
  "Tool-list change signalling"), so clients must reconnect after an upgrade to see new parameters.
- `docs/dev/write-tools-sandbox-test.md` (from P8-43) expanded into a step-by-step plan: account setup, the exact
  calls with expected text and structured output per tool (`dry_run`, missing `confirm`, input checks, approval
  required by default with an askable and a non-askable client, idempotent issue writes, the private dashboard and its
  limits, audit and rate limit, owner-only scope), and a "must never happen" list. Based on `write-common.ts`,
  `writes.ts`, `writes-dashboard.ts`, ADR-0015/0016, P7-25/P7-33.
- Links from `docs/dev/testing.md` and the owner checklist.

## Acceptance criteria
- [x] The async recipe matches `packages/core/src/tools/query.ts` and `packages/core/src/nrql/engine.ts` (submit,
      poll count and wait, pending output, Tasks and sync fallbacks); no server change and no test hook.
- [x] The write plan covers all four tools: `dry_run` never writes (and makes no approval prompt or intent row),
      `confirm` required, approval required by default, once-only application, audit-before-write, and lists what
      must never happen.
- [x] Evidence uses placeholders only (`<APP>`, `<account>`, `<entity guid>`, `<issue id>`).
- [x] The `listChanged` note is on the page; changing it is listed as an owner decision, not implemented.
- [x] Linked from `docs/dev/testing.md` and `docs/pending-decisions/owner-checklist.md`.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
Documentation only. The write plan restates existing controls (ADR-0015, ADR-0016, THREAT_MODEL T6, T14, T31) and
asks for a dedicated sandbox account and placeholders in evidence (public repository).

## Docs to update
- `docs/dev/verification-guide.md` (new), `docs/dev/write-tools-sandbox-test.md`, `docs/dev/testing.md`, `docs/RESEARCH.md`,
  `docs/pending-decisions/owner-checklist.md`.

## Out of scope
- A server-side switch or hook to force pending handles.
- Server-sent `tools/list_changed` on HTTP (owner decision; would need sessions, contradicting ADR-0005).
- Running either plan live.
