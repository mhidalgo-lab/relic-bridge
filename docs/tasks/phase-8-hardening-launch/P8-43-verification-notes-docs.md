---
id: P8-43
title: Docs from the 0.8.0 verification run
phase: 8
status: review
priority: low
depends_on: []
adr: [0016]
owner: claude-agent
---

# P8-43 — Docs from the 0.8.0 verification run

## Goal
Document two findings of the 0.8.0 verification run (2026-10-13): scripted clients can get HTTP 403 from an edge rule
in front of a deployment, and the four write tools have never had a written sandbox test plan.

## Scope
- Troubleshooting entry for HTTP 403 to scripted clients (default library User-Agent) while curl works. Generic: not
  relic-bridge, send a normal User-Agent, operators can allow API clients in their edge settings.
- A sandbox test plan for `create_change_event`, `acknowledge_issue`, `close_issue` and `create_dashboard`
  (dedicated account, `dry_run` never writes, approval, rate limit, audit rows, owner-only scope).
- An owner-checklist item pointing to the plan.

## Acceptance criteria
- [x] `docs/guide/troubleshooting.md` explains the 403 and the fix without naming a product setting that is not verified.
- [x] `docs/dev/write-tools-sandbox-test.md` covers the points above and is linked from `docs/dev/testing.md`.
- [x] `docs/pending-decisions/owner-checklist.md` links the plan.
- [x] `pnpm lint`, `pnpm typecheck` and the tests pass; generated docs regenerated.

## Security notes
none (documentation only; the plan restates existing controls: ADR-0015, ADR-0016, T6, T31).

## Docs to update
- `docs/guide/troubleshooting.md`, `docs/dev/testing.md`, `docs/dev/write-tools-sandbox-test.md`,
  `docs/pending-decisions/owner-checklist.md`.

## Out of scope
- Changing edge or bot-protection behaviour; running the plan against a real account (owner action).
