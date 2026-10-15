---
id: P8-76
title: Security test gaps (T12, T25, paging, windows, route-table guards, Worker host checks, workflow pins)
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-76 — Security test gaps

## Goal
Several security properties are claimed in `docs/THREAT_MODEL.md` and in code but not pinned by a test, or are pinned only for
part of the surface. This task adds the tests; if a test finds a real defect, fix it in a separate commit and say so.

## Scope
Verify each item against the current tests first and drop the ones already covered.
- **T12, no token forwarding:** an outbound request (NerdGraph, CIMD fetch, OTLP export) never carries the inbound
  `Authorization` bearer or a relic-bridge token. Drive a request through the HTTP app with a recording fetch and assert on
  every outbound header set (`packages/http-app/test`, next to `passthrough.test.ts`, which covers only the pass-through
  route).
- **T25, OAuth grant rows:** the provider keeps some fields in plaintext by design (THREAT_MODEL T25, accepted in section
  4a: the resource, so the project slug, and the grant metadata with the access grant id). Pin exactly those: after a
  full authorization and a refresh, the slug appears only in the grant's `resource` and the token's `audience`, the
  access grant id only in the grant `metadata.grant`, neither in any key name, and the sealed `props` show neither (nor
  the user id). Inspect the rows on every host the OAuth suite runs on (memory, SQLite, D1). *(Refined: the original
  wording, "no plaintext slug and no plaintext grant id", contradicts the accepted design.)*
- **Paged tools:** add `get_related_entities` to `PAGED_TOOLS` in `packages/http-app/test/authz/tools.test.ts` (the cursor
  binding test), after confirming the tool pages.
- **Window refusals for the composite reports:** `generate_alert_insights_report` and `generate_user_impact_report`
  (`packages/core/src/tools/reports.ts`) refuse a window beyond the limit before any request, like the other tools
  (`packages/core/test/tools-reports.test.ts`).
- **Route-table guards:** a test that walks the admin UI route table (`packages/admin-ui`, `packages/http-app`) and fails if
  a POST handler does not run the CSRF check, and the admin API route table (`packages/http-app/src/admin/api.ts`) so every
  change route writes its audit row.
- **Worker Host/Origin at runtime:** run `apps/worker` with `RB_ALLOWED_HOSTS` set and assert a wrong `Host` and a wrong or
  `null` `Origin` are refused on `/p/:slug/mcp` and `/admin` (check what the authz matrix over `apps/worker/test/authz-host.ts`
  already covers; add only the missing cases).
- **SHA pins for every workflow:** an action in each `.github/workflows/*.yml` is pinned by a 40-hex commit. Today the check
  exists per file only in `scripts/test/docker-workflow.test.ts` (docker.yml), `scripts/test/bench-cpu.test.ts` and, for one
  step, `scripts/test/release.test.ts`; there is no test over all workflows. If P8-07 adds a workflow-hardening test that
  covers all files, drop this item. *(Checked 2026-10-15: `scripts/test/workflow-hardening.test.ts` from P8-07 checks the
  pin of `harden-runner` only, in every file; the item stays and extends that file to every `uses:`.)*

## Acceptance criteria
- [x] Each listed test exists, fails when the property is broken (show by temporarily breaking it locally, noted in the PR),
      and passes on `main`.
- [x] Items found already covered are listed in the PR description with the existing test name.
- [x] Any defect found has its own fix commit, a changeset, and a THREAT_MODEL note.

## Security notes
T12, T25, T3, T13, T24, T18. Tests must use fake keys and tokens and never print them.

## Docs to update
- `docs/THREAT_MODEL.md` (point the T12 and T25 rows at the new tests), `docs/dev/testing.md`.

## Out of scope
- New features; fuzzing.

## Outcome
- None of the listed items was already covered; all tests were added (see the PR for the file and test names).
- Each new test was shown to fail with the property broken locally: an `Authorization` header added to NerdGraph
  requests and a `cookie` header passed to the CIMD fetcher (T12); the project resource added to the grant metadata
  (T25); `get_related_entities` ignoring its cursor (paging); `lookbackRange` without the window check (insights report);
  the CSRF check removed from `kit.form` (UI guard); the Host and Origin middleware disabled (Worker); one action pinned by
  tag (workflows). The audit guard and the impact-report test failed on `main` as written.
- Defects found (ordinary bugs, fixed in their own commits with changesets and THREAT_MODEL notes):
  `POST /api/admin/v1/users/{id}/oauth-devices/{deviceId}/revoke` answered 404 for an unknown user without an audit row;
  `generate_user_impact_report` with an `issue_id` and an over-limit `time_range` spent one request on the issue lookup
  before refusing.
