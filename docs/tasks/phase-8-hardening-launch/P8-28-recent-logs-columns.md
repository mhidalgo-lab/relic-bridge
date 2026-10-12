---
id: P8-28
title: list_recent_logs reads a fixed column set
phase: 8
status: in-progress
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-28 — list_recent_logs reads a fixed column set

## Goal
Follow-up of BUG-25 / BUG-03 from the live test run (2026-10-12): P8-23 made `list_recent_logs` use `SELECT *`, which on
accounts with very wide Log events (hundreds of attributes, multi-KB payloads) can push a page over `maxResponseBytes`
(`RB_LIMIT_RESPONSE_TOO_LARGE`). Select an explicit, truncated column list instead.

## Scope
- Columns: `timestamp`, `level` and aliases (`severity`, `log.level`), `messageId`, `message`/`log`/`logged_message`
  cut with `substring` at 500 characters, and a small fixed set of context attributes (`service.name`, `hostname`,
  `logger`, `request_id`, `trace.id`) cut at 60 characters for the compact summary.
- Keep BUG-24 paging/tiebreaker behaviour and the BUG-25 fallback order. No description or schema growth.

## Acceptance criteria
- [ ] The generated NRQL never contains `SELECT *`; long text columns are cut in NRQL.
- [ ] A fixture of very wide rows stays under the response cap; level aliases are shown when `level` is absent.
- [ ] Tool description sizes stay within the existing budgets (no budget change).
- [ ] RESEARCH.md updated; changeset added.

## Security notes
T4: column names go through `nrql.identifier()`, lengths are template numbers. No access behaviour changes.

## Docs to update
- `docs/RESEARCH.md`, generated docs if affected.

## Out of scope
- Showing arbitrary attributes of a line.
