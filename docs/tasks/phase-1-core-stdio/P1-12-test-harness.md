---
id: P1-12
title: Test harness (fixtures, MCP contract tests, optional live suite)
phase: 1
status: todo
priority: high
depends_on: [P1-01]
adr: []
owner: ""
---

# P1-12 — Test harness

## Scope
- msw-based NerdGraph mock loading sanitized fixtures (from P0-09).
- In-memory MCP client helper (SDK v2 client) for contract tests: list tools, call tool, assert schema-valid outputs.
- Live suite `pnpm test:live` gated by `RB_LIVE_*` env vars; never runs in public CI on forks; read-only queries only.
- Coverage threshold for `core` (e.g. 85% lines) enforced in CI.

## Acceptance criteria
- [ ] Contract tests run for every registered tool automatically (iterate registry).
- [ ] Live suite documented and skipped cleanly without env.

## Security notes
Live-suite secrets only in a protected environment; not available to fork PRs.

## Docs to update
- CONTRIBUTING (testing).

## Out of scope
- Workers pool tests (P3-06).
