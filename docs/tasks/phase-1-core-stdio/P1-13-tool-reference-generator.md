---
id: P1-13
title: Generated tool reference docs
phase: 1
status: todo
priority: medium
depends_on: [P1-06]
adr: []
owner: ""
---

# P1-13 — Generated tool reference docs

## Scope
- `pnpm docs:tools` generates `docs/reference/tools.md` from the registry (name, description, inputs, outputs, annotations, cost, phase).
- CI check: generated file up to date.

## Acceptance criteria
- [ ] Changing a tool description without regenerating fails CI.

## Security notes
none.

## Docs to update
- `docs/reference/tools.md` (generated).

## Out of scope
- Docs site (P8-04).
