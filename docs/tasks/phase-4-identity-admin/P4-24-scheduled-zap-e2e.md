---
id: P4-24
title: Weekly schedule for the ZAP scan and browser E2E workflows
phase: 4
status: done
priority: low
depends_on: [P4-11, P4-12]
adr: []
owner: claude-agent
---

# P4-24 — Weekly schedule for the ZAP scan and browser E2E workflows

## Goal
Owner decision (pending-decisions phase 4, P4-12 / P4-11, 2026-10-09): run the passive ZAP scan and the browser E2E
weekly as a regression net. Start only after GitHub Actions billing is fixed.

## Scope
- Add a weekly `schedule` trigger to `.github/workflows/zap.yml` and `.github/workflows/e2e.yml` (keep
  `workflow_dispatch`); scheduled runs use `main` only.

## Acceptance criteria
- [x] Both workflows have a weekly cron; workflow tests (if any) updated; `actionlint` passes.

## Security notes
No secrets added; scheduled runs use the same throwaway database as manual runs.

## Docs to update
- `docs/dev/` CI section listing scheduled workflows.

## Out of scope
- Making either a required check.
