---
id: P0-05
title: AI-agent workflow and task tooling
phase: 0
status: review
priority: high
depends_on: [P0-01]
adr: [0001]
owner: ""
---

# P0-05 — AI-agent workflow and task tooling

## Goal
Make it easy and safe for AI coding agents (and humans) to pick, execute and close tasks.

## Scope
- Refine `AGENTS.md` (canonical agent instructions) and keep `CLAUDE.md` importing it.
- `scripts/tasks.ts` exposed as `pnpm tasks`:
  - `list [--phase N] [--status S]` — table of tasks
  - `next` — first unblocked `todo` task (dependencies done; phase, then priority order)
  - `check` — validate front matter (schema, unique ids, existing dependency ids, no cycles, status enum); runs in CI
  - `graph` — Mermaid dependency graph to stdout
- Regenerate the task index table in `docs/ROADMAP.md` between markers (`<!-- tasks:start -->` / `<!-- tasks:end -->`) via `pnpm tasks index`.

## Acceptance criteria
- [x] `pnpm tasks check` passes on the current tree and fails on a broken dependency id.
- [x] `pnpm tasks next` prints P0-0x correctly given current statuses.
- [x] CI runs `pnpm tasks check`.

## Security notes
none (dev tooling only; no network).

## Docs to update
- `docs/tasks/README.md`, `AGENTS.md`.

## Out of scope
- Any issue-tracker sync.

## Progress notes
- 2026-10-01: `scripts/tasks.ts` (`list`, `next [--all]`, `check`, `graph`, `index`) with unit tests; `check` also fails when the
  ROADMAP index is stale; runs inside `pnpm lint` (so in CI). AGENTS.md updated with prior-art rules (GraphQL variables only,
  no module-level request state, no secrets in tool args, stderr-only logging).
