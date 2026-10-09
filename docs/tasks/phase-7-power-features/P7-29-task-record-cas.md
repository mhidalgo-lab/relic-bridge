---
id: P7-29
title: "Compare-and-swap on MCP task records"
phase: 7
status: review
priority: low
depends_on: [P7-23]
adr: []
owner: claude-agent
---

# P7-29 — Compare-and-swap on MCP task records

## Goal
Phase 7 review L: task records are read-modify-written (`packages/core/src/tasks.ts`, `getTask` / `cancelTask`). Two
concurrent `tasks/get` polls of one task can both pass the poll-interval check and both run a step (double budget and
quota spend), and a poll in flight can overwrite a `cancelled` state with `completed`. Only the task's owner can do
this, and rate limits and quotas still bound it.

## Scope
- A version (or `updatedAt`) check on write in every task store (memory, SQLite, D1, kv), losing writers retry or
  return the current state.

## Acceptance criteria
- [x] Test: two concurrent polls run one step; cancel during a poll stays `cancelled`.
- [x] THREAT_MODEL T32 residual updated.

## Docs to update
- `docs/THREAT_MODEL.md`.
