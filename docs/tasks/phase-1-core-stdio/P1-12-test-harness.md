---
id: P1-12
title: Test harness (fixtures, MCP contract tests, optional live suite)
phase: 1
status: done
priority: high
depends_on: [P1-01]
adr: []
owner: claude-agent
---

# P1-12 — Test harness

## Scope
- NerdGraph mock loading sanitized fixtures (from P0-09). Implemented as an injected `fetch` (`scriptedFetch`, plus the
  routed `mockNerdGraph()` replying per `Rb…` operation), not msw: consistent with P1-02, no `node:*`, works in Workers.
- In-memory MCP client helper (SDK v2 client) for contract tests: list tools, call tool, assert schema-valid outputs.
- Live suite `pnpm test:live` (`packages/core/test/live/*.live.ts`, own vitest config) gated by `RB_LIVE_API_KEY` / `RB_LIVE_ACCOUNT_ID` / `RB_LIVE_REGION`; never runs on PRs (manual `live.yml` workflow in a protected environment); read-only queries only.
- Coverage threshold for `core` 85% lines/statements/functions, 75% branches, enforced in CI via `pnpm test:coverage`.

## Acceptance criteria
- [x] Contract tests run for every registered tool automatically (iterate registry).
- [x] Live suite documented and skipped cleanly without env.

## Security notes
Live-suite secrets only in a protected environment; not available to fork PRs.

## Docs to update
- CONTRIBUTING (testing) — done.

## Out of scope
- Workers pool tests (P3-06).

## Implementation notes
- Existing per-tool tests keep their local helpers; consolidating their duplicated `connect()` boilerplate onto
  `test/helpers/mcp.ts` is a mechanical follow-up and was left out to keep this PR low-risk.
- The live suite has not been run (no key available); see pending decisions.
