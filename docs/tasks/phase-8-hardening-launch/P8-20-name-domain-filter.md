---
id: P8-20
title: Name lookup - optional domain/type, APM preference for APM-only tools
phase: 8
status: in-progress
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-20 — Name lookup: optional domain/type, APM preference for APM-only tools

## Goal
Every APM app with browser monitoring has a same-named BROWSER entity, so `name` lookups are ambiguous (live test run (2026-10-12), BUG-04). Let callers narrow a name with `domain` and `type`, and keep APM-only tools working with a bare name.

## Scope
- Add optional `domain` and `type` inputs (only valid together with `name`) to every tool that accepts `name`: the `NAME_INPUT` adapter tools and `get_entity`, `get_related_entities`, `get_golden_metrics`.
- APM-only tools (`list_top_transactions`, `analyze_transactions`, `analyze_deployment_impact`, `analyze_threads`, `list_gc_metrics`) stay pinned to the APM domain, so a bare name picks the APM candidate; no extra inputs there. `get_dashboard` stays pinned to dashboards.
- Ambiguity errors still list candidates; their hint now suggests `domain`.
- Keep the `tools/list` size budget (P7-27) green.

## Acceptance criteria
- [ ] `domain`/`type` accepted with `name`, refused with `entity_guid` or alone, validated as plain identifiers.
- [ ] Domain/type reach the entity search as query values (never concatenated raw); the resolver cache key already includes them.
- [ ] APM-only tools resolve a bare name to the APM entity when a same-named BROWSER entity exists.
- [ ] Ambiguity error keeps candidates and points to `domain`.
- [ ] Regression tests fail before the fix, pass after; tools/list budget test passes.
- [ ] Tool docs regenerated; RESEARCH.md and changeset updated.

## Security notes
No new access path: the resolver still searches only the connection's effective accounts, and the resolved guid still goes through `checkGuid`. Inputs are regex-restricted identifiers and are escaped by `entityQuery` (T4).

## Docs to update
- docs/reference tool docs (generated), docs/RESEARCH.md, task index.

## Out of scope
- Other live-run bugs (separate tasks).
