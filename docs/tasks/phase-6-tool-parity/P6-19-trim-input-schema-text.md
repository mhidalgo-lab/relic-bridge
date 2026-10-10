---
id: P6-19
title: "Trim tool input schema text (tools/list size)"
phase: 6
status: done
priority: low
depends_on: [P6-13]
adr: []
owner: claude-agent
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
- [x] `tools/list` catalogue at least 15% smaller than after P6-13 (61 267 to 51 980 characters, 15.2%); budget lowered to 52 000.
- [x] Description lint and router baseline still pass; no input name, type or validation change.
- [ ] `pnpm eval:tools` tool-choice rate not lower than the P6-13 baseline (once that baseline exists). Not run: needs an
      API key and spends money; the owner runs it before merging (see the phase-6 decisions log).

## Security notes
None: wording only. Field descriptions must keep stating account and scope rules (T3).

## Docs to update
- `docs/reference/tools.md` (generated), `docs/dev/evals.md` (size table).

## Out of scope
- Tool renames or schema changes; deferring tools (tool search) on the client side.
