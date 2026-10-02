---
id: P6-13
title: "Tool description quality and agent evals"
phase: 6
status: todo
priority: medium
depends_on: [P6-10]
adr: []
owner: ""
---

# P6-13 — Tool description quality and agent evals

## Scope
- Eval set (~40 realistic questions) → expected tool choice / successful answer, run against fixtures with a real model; track pass rate per release.
- Iterate descriptions, names, schemas; release v0.6.0.

## Acceptance criteria
- [ ] Baseline pass rate recorded; regressions block release.

## Security notes
Include prompt-injection eval cases (logs containing instructions).

## Docs to update
- `docs/dev/evals.md`.

## Out of scope
- —
