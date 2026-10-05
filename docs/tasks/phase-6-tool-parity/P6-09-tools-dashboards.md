---
id: P6-09
title: "Tools: list_dashboards, get_dashboard"
phase: 6
status: todo
priority: medium
depends_on: [P5-07]
adr: []
owner: ""
---

# P6-09 — Tools: list_dashboards, get_dashboard

## Scope
- `list_dashboards` (read-only, group `entities`, phase 6, cost 1): one account per call (`resolveAccounts`, default account
  otherwise). Entity search `domain = 'VIZ' AND type = 'DASHBOARD'`, `accountId`, optional `name` LIKE, `limit` (default 25, max
  100), `cursor` -> `next_cursor`. Per dashboard: guid, name, permissions, permalink. Names are third-party text (T6).
- `get_dashboard` (read-only, cost 1): by `guid` (`checkGuid` offline before any request; NerdGraph must agree on the account).
  Returns pages and widgets: title, visualization id, and per widget the NRQL queries (with their account ids) and markdown text so
  agents can reuse them. Caps: 20 pages, 50 widgets per page, 5 queries per widget. `minimal_output` drops queries and markdown.
- **Widgets are never executed.** There is no `run_dashboard_widget`: widget NRQL is raw NRQL written by a third party, possibly
  for another account. It is returned as data inside the untrusted-data envelope; an agent that wants numbers passes it to
  `run_nrql`, which enforces the `rawNrql` switch, account scope, allow/deny lists and query limits. (Decision logged in
  `docs/pending-decisions/phase-6.md`.)
- Widgets whose queries name an account outside the connection's access: query text and markdown are withheld and the widget says
  so (T3); title and visualization remain.

## Acceptance criteria
- [ ] Fixture + contract tests; account filtering enforced (P2-12 `TOOL_CASES`, including a forged foreign dashboard).
- [ ] Widget NRQL and markdown enveloped, redacted, capped; injection tests; widgets for foreign accounts withheld.
- [ ] No widget execution path; GraphQL documents use variables only.
- [ ] Accurate `cost`; pagination via `next_cursor`; `docs/reference/tools.md` regenerated; THREAT_MODEL, RESEARCH updated;
  owner decisions logged.

## Security notes
T3 (account filter, GUID agreement, foreign widget accounts), T4 (`entityQuery` only; widget NRQL never executed here), T6
(names, descriptions, widget NRQL and markdown).

## Docs to update
- Tool reference (generated), ARCHITECTURE tool table, THREAT_MODEL, RESEARCH, ROADMAP status, phase-6 pending decisions.

## Out of scope
- Creating or changing dashboards (P7-09), executing widgets, dashboard snapshots/PDF export.
