---
id: P6-10
title: "Composite reports: alert insights and user impact"
phase: 6
status: review
priority: medium
depends_on: [P6-02, P6-04, P6-06]
adr: [0010]
owner: claude-agent
---

# P6-10 — Composite reports: alert insights and user impact

## Scope
- New module `packages/core/src/tools/reports.ts` (`createReportTools(deps)`, group `incident-response`, phase 6). Composites
  **reuse the existing tools**: each section calls the sibling tool's handler with schema-parsed arguments and the same
  per-request `ToolContext`, so every scope check (T3), text cleaning and envelope (T6) and budget spend is the original one.
  No NerdGraph or NRQL logic is duplicated.
- Issue lookup by id: `aiIssues.issues(filter: { ids: [$id] })` (`ids` exists on `AiIssuesFilterIssues`, P0-09 introspection).
  The returned row must carry the requested id and pass the P6-02 scope rule (every account and entity GUID allowed); a row
  that touches a foreign account is refused (`RB_AUTH_FORBIDDEN`), a missing row is `RB_INPUT_INVALID`. One account per call.
- `generate_alert_insights_report { issue_id, account?, lookback?, before_minutes?, change_lookback_hours?, sections?,
  max_metrics? }` (cost 14). Window: issue onset (`activatedAt`/`createdAt`) minus `before_minutes` (default 30) until it
  closed (or now), cut to the connection's window limit. Primary entity: the issue's first entity. Sections, in priority
  order: `entity` (get_entity), `golden_metrics` (get_golden_metrics, default 5 metrics), `errors` (list_error_groups by
  occurrences), `logs` (analyze_entity_logs), `changes` (list_change_events, from `change_lookback_hours` (default 24) before
  the window), `related` (get_related_entities, 25).
- `generate_user_impact_report { issue_id | entity_guid, account?, lookback?, time_range?, compare?, max_entities? }`
  (cost 9). Affected entities: the issue's entities or the given entity. Front ends: affected entities that are browser apps,
  mobile apps or synthetic monitors, plus those related to the affected entities (get_related_entities, at most 3 lookups).
  Signals per front end, one query per kind and account (FACET entityGuid): browser (`PageView`, `JavaScriptError`: page
  views, average load, sessions, JS errors, sessions with errors), mobile (`MobileSession`, `MobileCrash`: sessions, users,
  crashes, users with crashes), synthetics (P6-08 `checkQuery`/`readChecks`: checks, failures, failing locations). Browser
  and mobile also compare with the equal window before (`compare`, default true) and flag clear changes.
- **Budget planning (ADR-0010):** before running, sections are planned in priority order against `ctx.budget.remaining`;
  a section runs only when its full cost fits (golden metrics shrink `max_metrics` to fit). Planned sections run in parallel.
  Each section reports `ok`, `partial`, `error`, `skipped` (budget) or `not_applicable`; the report says `partial: true` and
  names what is missing. Credential/authorization errors (`FATAL_CODES`) abort the whole report (fail closed).
- Both costs are below the Workers Free budget (45), so both tools are listed there; the reduced depth on a smaller budget is
  the planner above (documented in the tool descriptions).
- MCP **Tasks** for long runs: not used here (stateless per-request servers); tracked by P7-13.

## Acceptance criteria
- [x] Both tools registered, read-only, with output schemas; contract sample calls and P2-12 `TOOL_CASES` (foreign account,
  foreign GUID, forged issue touching a foreign account, NerdGraph disagreeing on an entity's account).
- [x] Sections reuse the sibling tools; no new GraphQL besides the `ids` filter variable; NRQL only via the `nrql` tag.
- [x] Budget planner unit-tested: full plan, reduced golden metrics, skipped sections, partial markers; works within the
  Free-plan budget with reduced depth (documented).
- [x] Untrusted text only inside envelopes (T6); injection test on a hostile issue title.
- [x] Tool reference regenerated; ARCHITECTURE, THREAT_MODEL, RESEARCH updated; owner decisions logged.

## Security notes
T3 (issue rows that touch foreign accounts refused; every sub-call keeps its own checks), T4 (variables / `nrql` tag only),
T6 (aggregates lots of untrusted text: each section's text is the sibling tool's enveloped text).

## Docs to update
- Tool reference (generated), ARCHITECTURE tool table, THREAT_MODEL, RESEARCH, phase-6 pending decisions.

## Out of scope
- LLM summarisation server-side (the client agent reasons).
- MCP Tasks for long runs (P7-13); APM/OTel service signals in the user-impact report (golden metrics cover them).
