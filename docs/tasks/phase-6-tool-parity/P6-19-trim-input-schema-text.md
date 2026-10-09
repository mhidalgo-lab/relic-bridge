---
id: P6-19
title: "Trim tool input schema text (tools/list size)"
phase: 6
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P6-19 — Trim tool input schema text (tools/list size)

## Goal
After P6-13 the descriptions are about a third of the `tools/list` payload (61 267 characters for 36 tools); the input
JSON Schemas are the other two thirds. Every conversation pays for them, so trim the repeated field text without losing
what agents need.

## Scope
- Measure per-field description sizes; share wording for repeated fields (`account`, `cursor`, `minimal_output`,
  `time_range`, the entity `name`/`account` pair) through one constant each.
- Remove field text that only repeats the description or the schema (enum lists, defaults already in `default`).
- Lower `TOOLS_LIST_BUDGET` (`packages/core/test/evals/quality.ts`) to the new size; keep the offline router baseline.

## Acceptance criteria
- [ ] `tools/list` catalogue at least 15% smaller than after P6-13; budget lowered to match.
- [ ] Description lint and router baseline still pass; no input name, type or validation change.
- [ ] `pnpm eval:tools` tool-choice rate not lower than the P6-13 baseline (once that baseline exists).

## Security notes
None: wording only. Field descriptions must keep stating account and scope rules (T3).

## Docs to update
- `docs/reference/tools.md` (generated), `docs/dev/evals.md` (size table).

## Out of scope
- Tool renames or schema changes; deferring tools (tool search) on the client side.
