---
id: P1-13
title: Generated tool reference docs
phase: 1
status: in-progress
priority: medium
depends_on: [P1-06]
adr: []
owner: claude-agent
---

# P1-13 — Generated tool reference docs

## Scope
- `pnpm docs:tools` generates `docs/reference/tools.md` from `createBuiltinTools()` (name, title, group, description,
  input and output fields from the JSON Schema, derived MCP annotations, cost, phase). Output is deterministic.
- `pnpm docs:tools --check` exits non-zero when the file is stale; it runs as part of `pnpm lint` (so CI).
- Generator lives in `scripts/gen-tool-docs.ts` (not shipped; may import core since scripts are Node-only) with a unit test.
- Config-file reference generation is out of scope (new task if wanted).

## Acceptance criteria
- [ ] Changing a tool description without regenerating fails `pnpm lint` (and so CI).
- [ ] `docs/reference/tools.md` lists all 13 tools with inputs, outputs, annotations, cost and phase.
- [ ] Generator test covers rendering and staleness detection.

## Security notes
none.

## Docs to update
- `docs/reference/tools.md` (generated).

## Out of scope
- Docs site (P8-04).
