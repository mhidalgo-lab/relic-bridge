---
id: P8-108
title: Non-APM entities in APM tools, and dependency_health with no neighbours
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-108 — Non-APM entities in APM tools, and dependency_health with no neighbours

## Goal
First mobile test (Claude Android), issues 4 and 5:
- For a non-APM entity, `analyze_transactions` returns "inconclusive" with zeros while `analyze_deployment_impact`
  refuses with `RB_INPUT_INVALID`.
- `dependency_health` on an entity with no neighbours lists "Throughput down 46%" for the entity itself but reports
  "0 with signals", and skips Response time.

## Scope
- Pick one rule for APM-only tools given a non-APM entity (prefer: a clear `RB_INPUT_INVALID` naming the entity's
  domain/type and the tool to use instead, as `analyze_deployment_impact` does), and apply it to every APM-only tool
  (`analyze_transactions`, `list_top_transactions`, `analyze_threads`, `list_gc_metrics`, … check each). Tools that
  legitimately work on other entity types keep working.
- `dependency_health`: count the entity's own signals in the summary (or report them separately and say so), and
  explain in a note why a metric was skipped (for example no data for this entity type).

## Acceptance criteria
- [x] Tests for each APM-only tool with a non-APM entity.
- [x] Tests for `dependency_health` with no neighbours: the summary agrees with the rows, skipped metrics have a reason.
- [x] Generated tool docs regenerated.

## Security notes
None.

## Docs to update
- Generated tool docs, changeset (patch).

## Out of scope
- New metrics for non-APM entities.

## Owner decisions
- 2026-10-16: `analyze_deployment_impact` uses the same no-request `requireApmApplication` check and message as the other
  APM-only tools (`list_top_transactions`, `analyze_transactions`, `analyze_threads`, `list_gc_metrics`). Its later
  entity lookup stays, to catch a GUID whose reported domain/type disagrees.
