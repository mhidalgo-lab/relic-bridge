---
id: P6-16
title: "Investigation workflow tools (error trace, dependency health)"
phase: 6
status: in-progress
priority: medium
depends_on: [P6-05, P6-06, P6-03]
adr: [0010]
owner: claude-agent
---

# P6-16 — Investigation workflow tools (error trace, dependency health)

## Goal
Compound tools organised around investigations rather than data types (prior-art: adjohn, official `analyze_*` tools).

## Design (v1 ships all three candidates)
New module `packages/core/src/tools/investigations.ts` (`createInvestigationTools(deps)`, phase 6). Same rules as the P6-10
reports: sibling tools' handlers are reused with the same per-request context (scope checks, cleaning, envelopes, budget
spend stay the original ones), requests are planned with `planBudget` before anything runs, and what does not fit is marked
skipped / partial (ADR-0010). Credential and authorization errors abort the whole call.

- `trace_error { trace_id | error_group_id, entity_guid?, include_synthetic?, time_range?, account? }` (cost 4; group
  `incident-response`). One account per call (`entity_guid` implies its account). With `error_group_id`, one NRQL query finds
  the latest traced `TransactionError` of the group (`error.group.guid`), excluding synthetic traffic unless
  `include_synthetic`. Then, planned against the budget in this order: `Span` rows of the trace (services, root span, every
  error span, slowest spans), `TransactionError` rows with request attributes (query strings removed from `request.uri`),
  `Log` rows carrying the `trace.id`. No spans means the trace may be sampled out: reported as `spans_missing` with the other
  parts still returned. NRQL only through the `nrql` tag; ids validated by charset.
- `dependency_health { guid, direction?, max_dependencies?, max_metrics?, since? }` (cost 17 at defaults): related entities
  (P1-08 handler, which already drops other accounts and reports `hidden_outside_scope`), alerting neighbours first, then each
  of the entity and up to `max_dependencies` neighbours measured with the P1-09 golden-metrics handler; flags for alert state,
  not reporting, error/latency/CPU/memory trending up or throughput trending down by 25% or more.
- `entity_health { guid, time_range?, lookback_days?, max_metrics? }` (cost 10): `get_entity`, `get_golden_metrics`,
  `list_recent_issues` (open ones), `list_error_groups` (unresolved, by occurrences), `list_change_events` (deployments), in
  that priority order, same section/status model as the alert insights report.
- Out of scope for v1 (new tasks if wanted): `around` parameter for logs; resolving entity names inside these tools (P6-14's
  `resolve_entity` first); cross-account trace stitching.

## Acceptance criteria
- [ ] Design above approved (owner decisions logged in `docs/pending-decisions/phase-6.md`); the three tools implemented.
- [ ] Fixture tests: happy path, sampled-out trace, budget planning, failing part, hostile text in envelopes, input validation.
- [ ] Negative authorization cases for all three in the P2-12 suite; contract sample calls; CLI e2e tool count bumped.
- [ ] Prompts (P6-11) reference the tools; tool reference regenerated; THREAT_MODEL and RESEARCH updated.
- [ ] Evals (P6-13) updated: P6-13 is not started in this stack, so its task file gets a note to cover these tools.

## Security notes
T6 — large amounts of untrusted text aggregated; keep the envelope: every NR-sourced string is cleaned and shown only inside
`shapeRows`/envelope blocks, never in the free text around them. T3 — account from the guid/argument before any request;
neighbours outside the effective accounts are dropped, never fetched.

## Docs to update
- Tool reference; prompts (P6-11) reference these tools; THREAT_MODEL; RESEARCH (unverified attribute names).

## Out of scope
- Server-side LLM summarisation.
