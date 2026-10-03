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
- The authorization and isolation suite of P2-12 (`packages/http-app/test/authz/`) runs unchanged against the Worker
  (`createWorker` on local D1, hostile NerdGraph injected) under the Workers pool: the same matrix data and test files, a
  pluggable host in the shared harness (no duplicated cases). Tests that exercise only http-app internals (route-table
  guard, admin-off app) stay http-app only.
- Already covered by earlier Phase 3 tests, so only checked here: storage contract and D1 behaviour (P3-02), MCP end to
  end through the deployed entry, migrations on first boot, key-check boot failure (503), plan presets, audit rows
  through `waitUntil`, rate limiting. Gaps found are closed here (a boot test of the entry with a wrong master key).
- Optional nightly deploy to a staging Worker with a smoke test (protected environment): needs a real Cloudflare account,
  so the workflow is committed disabled-by-default (skips cleanly without secrets) and the owner steps are logged.

## Acceptance criteria
- [ ] The P2-12 matrix, tools and isolation suites run against the Worker in the Workers pool.
- [ ] Migrations on startup, wrong-master-key 503, plan budget enforcement, `waitUntil` audit rows and two-project
      isolation are each asserted against the Worker.
- [ ] CI job "Workers runtime tests" runs on PRs (making it a required check is a repo setting: owner step).
- [ ] Nightly staging smoke workflow skips cleanly without secrets.

## Security notes
Staging credentials only in protected environment.

## Docs to update
- CONTRIBUTING, docs/dev/testing.md.

## Out of scope
- Making the check required in branch protection (repo setting).
