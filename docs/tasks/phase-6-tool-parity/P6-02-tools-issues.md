---
id: P6-02
title: "Tools: list_recent_issues, search_incidents"
phase: 6
status: done
priority: high
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-02 — Tools: list_recent_issues, search_incidents

## Scope
- `list_recent_issues`: `account(id).aiIssues.issues(cursor, filter, timeWindow)`; filters `states`, `priority`, `entity_guid`
  (implies its account), `policy_id`, `acknowledged`, `contains`; `time_range` (default last 24 hours, capped by the
  connection's window limit). Output: id, title, state, priority, created/activated/acknowledged/closed/updated times, entities,
  policy and condition names, muting state, incident count, link.
- `search_incidents`: `account(id).aiIssues.incidents(cursor, filter, timeWindow)`; filters `states`, `priority`, `entity_guid`,
  `contains` (the incident filter has no text search, so it is applied to the fetched page; documented in the tool text).
- Both: one account per call, read-only, cost 1, group `alerting`, `next_cursor` pagination, `minimal_output`, NR text
  enveloped (T6). A row is shown only if it names the requested account and every account id and entity GUID it carries is
  allowed on the connection; otherwise it is dropped whole and `hiddenOutsideScope` is set (T3).
- The documented experimental opt-in header (`nerd-graph-unsafe-experimental-opt-in: AiIssues`) is sent on these documents only.
- The `NrAiIssue`/`NrAiIncident` NRQL fallback is not needed: the introspected API exposes every field in scope. Left out until a
  real gap shows up (`run_nrql` still reaches those event types).

## Acceptance criteria
- [x] Fixture + contract tests (`tools-issues.test.ts`, sample calls in `contract.test.ts`); account filtering enforced
  (P2-12 `TOOL_CASES`, hostile mock).
- [x] Every value is a GraphQL variable; titles, descriptions and entity names are inside the untrusted-data envelope.
- [x] `docs/reference/tools.md` regenerated; THREAT_MODEL and RESEARCH updated.

## Security notes
T3 (rows re-checked, whole row dropped when it touches a foreign account), T4 (variables only), T6 (issue titles/descriptions enveloped).

## Docs to update
- Tool reference (generated), THREAT_MODEL, RESEARCH.

## Out of scope
- Acknowledge/close (P7-09); multi-account listing in one call; `issuesEvents`/`incidentsEvents` (event streams).
