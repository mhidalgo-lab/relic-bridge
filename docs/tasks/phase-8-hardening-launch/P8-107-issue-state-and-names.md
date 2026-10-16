---
id: P8-107
title: One issue state across tools, and names for AIOPS issue entities
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-107 — One issue state across tools, and names for AIOPS issue entities

## Goal
First mobile test (Claude Android), issues 2 and 3:
- `list_recent_issues` shows `ACTIVATED` for an open issue while `generate_alert_insights_report` and the
  `acknowledge_issue` dry run show `CREATED` for the same issue. P8-100 noted the same split right after a write and
  put it down to read lag; on mobile it showed long after the issue opened, so it may be a different field or query.
- `get_related_entities` returns `AIOPS/ISSUE` entities with empty names (2 of 3), and the alert insights report has
  the same gap.

## Scope
- Find where each tool reads the issue state (query, field, filter) and explain the difference. Make all tools report
  the same state, or label each value so it is clear what it is. Record the finding in RESEARCH.md.
- For entities with an empty name, fall back to something useful (for AIOPS issues, the issue title if it can be had
  in the same request, else a label such as "(unnamed issue <short id>)") and say so in the row.
- Use the sandbox (relic-mhidalgo MCP tools or NerdGraph through the repo's dev tooling, read-only) to confirm the
  real shapes if needed. Never write.

## Acceptance criteria
- [x] Tests showing the same issue reported with the same state by list, insights report and ack/close dry run.
- [x] Tests for unnamed related entities.
- [x] RESEARCH.md updated.

## Security notes
Issue titles are New Relic data: keep them inside the untrusted output (T5).

## Docs to update
- `docs/RESEARCH.md`, generated tool docs if descriptions change, changeset (patch).

## Out of scope
- Polling after writes (P8-100).
