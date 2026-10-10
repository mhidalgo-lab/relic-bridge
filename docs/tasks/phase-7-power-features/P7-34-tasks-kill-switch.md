---
id: P7-34
title: RB_TASKS=off switch for MCP Tasks
phase: 7
status: done
priority: low
depends_on: [P7-13, P7-29]
adr: []
owner: claude-agent
---

# P7-34 — RB_TASKS=off switch for MCP Tasks

## Goal
Owner decision (pending-decisions phase 7, P7-13, 2026-10-09): keep per-device task visibility, and add a server-level
kill switch for the hand-rolled MCP Tasks support, which depends on SDK internals.

## Scope
- `RB_TASKS=on|off` (default `on`) on `serve`, Worker and stdio. With `off`: the server does not advertise the tasks
  capability, task-augmented calls run synchronously (or are refused with a clear error if the spec requires it), and
  task routes answer as unknown.
- Composite report tools keep working without tasks.

## Acceptance criteria
- [x] With `off`, `initialize` has no tasks capability and no task record is written; tests on Node and Workers.
- [x] With the default, behaviour is unchanged (existing tests pass).

## Security notes
Reduces surface when disabled; T21 unchanged.

## Docs to update
- Configuration reference, `docs/guide/cloudflare-deploy.md` vars.

## Out of scope
- Sharing tasks across devices of a grant (decided against).
