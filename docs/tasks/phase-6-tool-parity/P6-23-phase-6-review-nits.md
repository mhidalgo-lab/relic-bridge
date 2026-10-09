---
id: P6-23
title: "Phase 6 review nits: lint gaps, test gaps, small correctness issues"
phase: 6
status: review
priority: low
depends_on: [P6-19]
adr: []
owner: claude-agent
---

# P6-23 — Phase 6 review nits: lint gaps, test gaps, small correctness issues

## Goal
Phase 6 review L4-L11 (`docs/reviews/phase-6-review.md`): items that are not exploitable today but weaken the guards
or the tests.

## Scope
- `entityQuery.and()` joins parts with ` AND ` and no parentheses: a future fragment with `OR` would escape the
  `accountId IN (...)` scope. Parenthesise each part.
- `scripts/check-nrql-templates.ts`: case-sensitive (`select ... from` passes), misses fragments without SELECT/FROM,
  entity-search strings not built with `entityQuery`, and `defineDocument` calls with `${}`; add checks.
- `likePattern` escapes `%` and `_` with a backslash; NRQL `LIKE` honouring `\%` / `\_` is unverified live (a value with
  `_` may silently match nothing). Verify with `pnpm test:live` and adjust.
- `nrql.identifier` accepts `--`, `//`, `/*` inside backticks (only `get_attributes` `event_type` is user-supplied):
  one live probe.
- `generate_user_impact_report` pairs `issue.entityGuids[i]` with `issue.entities[i]`, but empty names are dropped, so
  labels can shift (`reports.ts`).
- Authz suite: `analyze_deployment_impact`, `get_dashboard`, `dependency_health`, `entity_health` never reach a success
  path over HTTP; `get_dashboard` lacks a reachable-but-not-allowed GUID case; `trace_error` lacks a foreign
  `entity_guid` case; `list_synthetic_monitors`, `list_dashboards`, `analyze_kafka_metrics` lack a dedicated
  foreign-rows-dropped assertion.
- Prompts and resources are tested in memory and over HTTP, never over stdio (CLI e2e).
- Summary text says "skipped (budget)" for sections now also skipped for a missing grant.

## Acceptance criteria
- [x] `entityQuery.and()` parenthesises a part containing `OR` (test with an `OR` part).
- [x] `check-nrql-templates` is case-aware, flags clause fragments with an interpolation, entity-search filters not built
  with `entityQuery`, and GraphQL documents with an interpolation (tests in `scripts/test/`).
- [x] L6 / L7: live probes added to `pnpm test:live`; not run (no key, owner AFK), recorded as open in the review and
  `docs/RESEARCH.md`, owner decision in the Phase 6 pending-decisions log.
- [x] `generate_user_impact_report` no longer pairs names with GUIDs when a name was dropped (test).
- [x] Authz suite: success paths for `analyze_deployment_impact`, `get_dashboard`, `dependency_health`, `entity_health`
  (honest-entity convention in the harness); `get_dashboard` reachable-but-not-allowed case; `trace_error` foreign
  `entity_guid`; foreign-rows-dropped assertions for `list_synthetic_monitors` and `list_dashboards`.
  `analyze_kafka_metrics` accepted: it reads NRQL rows of one allowed account, so there are no per-row foreign entities.
- [x] Prompts and resources tested over stdio (CLI e2e).
- [x] Section summaries say "skipped (budget or grant, see the section notes)".

## Security notes
T3, T4 (defence in depth).

## Docs to update
- `docs/THREAT_MODEL.md` T4 row if the lint changes; `docs/RESEARCH.md` with the live results.

## Out of scope
- New tools.
