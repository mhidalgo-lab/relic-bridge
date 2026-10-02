---
id: P3-06
title: Workers integration tests in CI
phase: 3
status: todo
priority: high
depends_on: [P3-02]
adr: []
owner: ""
---

# P3-06 — Workers integration tests in CI

## Scope
- `@cloudflare/vitest-pool-workers` job: storage contract, authz/isolation suite (P2-12), MCP contract tests against the Worker.
- Optional nightly deploy to a staging Worker with smoke test (protected environment).

## Acceptance criteria
- [ ] CI job required on PRs.

## Security notes
Staging credentials only in protected environment.

## Docs to update
- CONTRIBUTING.

## Out of scope
- —
