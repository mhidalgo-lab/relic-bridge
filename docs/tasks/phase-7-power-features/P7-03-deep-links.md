---
id: P7-03
title: "Deep links to the New Relic UI"
phase: 7
status: review
priority: low
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-03 — Deep links to the New Relic UI

## Scope
- Never use `embeddedChartUrl` for deep links: it creates public links (T26).
- One offline tool, `get_ui_link` (no subrequest), taking exactly one of `entity_guid` (entities and dashboards: the
  `/redirect/entity/<guid>` permalink), `nrql` (query builder, prefilled) or `issue_id` (alert issue page).
- Region-aware host: US `one.newrelic.com`, EU `one.eu.newrelic.com`. JP has no documented UI host: refused.
- Links are built only from validated values: GUIDs through `checkGuid`, account ids through the connection's effective
  access, issue ids as UUIDs, the NRQL after the connection's limits (`rawNrql`, event types, window) have been enforced.
  Everything is URL-encoded; no NerdGraph free text ever reaches a link.
- Never use `embeddedChartUrl` / `staticChartUrl` for deep links: they create public links (T26).
- URL formats other than the entity permalink are NOT verified (no live UI access in the autonomous run): the tool says
  so in its description and output (`verified: false`) and RESEARCH records it.

## Acceptance criteria
- [x] Links for entities, dashboards, NRQL queries and issues, with the right host for US and EU; JP refused.
- [x] Accounts outside access, malformed ids, `javascript:` / path / host injection and disabled raw NRQL are refused.
- [x] No NerdGraph text is used in a link; no chart URLs involved.
- [x] Negative authorization cases in the authz suite; `tools/list` budget raised on purpose (54 400).
- [ ] Owner verifies the query-builder and issue URL formats in a browser for both regions (pending decision).

## Security notes
Links carry no secret and need the reader's own New Relic login. Offline, so no new request surface. Foreign-account
links are refused so the tool cannot be used to probe or enumerate accounts outside access.

## Docs to update
- Tool reference (generated), RESEARCH, THREAT_MODEL, phase-7 pending decisions.

## Out of scope
- Links in the output of every other tool (adds characters to each result); time-range-aware links; alert policy and
  synthetic monitor links; short links.
