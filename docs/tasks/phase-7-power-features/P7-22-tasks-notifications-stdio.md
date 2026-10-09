---
id: P7-22
title: "MCP Tasks: status notifications, stdio and pass-through"
phase: 7
status: todo
priority: low
depends_on: [P7-13]
adr: []
owner: ""
---

# P7-22 — MCP Tasks: status notifications, stdio and pass-through

## Goal
P7-13 serves Tasks only on the project HTTP route, poll-only. Extend it where it pays off.

## Scope
- `notifications/tasks` through `subscriptions/listen` (`notifications.taskIds`) on HTTP: needs a server-side poller
  (Durable Object alarm on Workers, a timer on `serve`) because the stateless route does no work after a response.
- stdio: the SDK 2.2.0 stdio server answers `tasks/*` with `-32601`; serve them once the SDK has a Tasks runtime (or a
  custom dispatcher), with an in-process store bound to the connection.
- Pass-through route: a task owner from the key fingerprint and a store that does not need project storage.
- Re-evaluate on each MCP TS SDK release whether its Tasks support can replace the hand-rolled `tasks/*` handling.

## Acceptance criteria
- [ ] Each part above is either implemented with tests (including negative authz) or recorded as not worth it.

## Security notes
T32, T21 (no task state in isolate memory on HTTP), T12 (pass-through keys are never stored).

## Docs to update
- `docs/guide/clients.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Composite reports (P7-21).
