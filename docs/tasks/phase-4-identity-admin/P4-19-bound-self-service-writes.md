---
id: P4-19
title: "Bound the storage writes signed-in users can cause"
phase: 4
status: todo
priority: low
depends_on: [P4-07, P4-10]
adr: []
owner: ""
---

# P4-19 — Bound the storage writes signed-in users can cause

## Goal
Phase 4 review L6, L7: cheap ways for any signed-in member to spend D1 writes (Free: about 100k per day).

## Scope
- `kit.issueOnce` writes a `ui-once:` row (2 h) on every GET and HEAD of a page that shows a token form
  (`/admin/me/tokens/new?grant=`, `/admin/connect`, the token pages). 25 GETs + 5 HEADs left 30 rows. Cap outstanding
  handles per user (reuse the newest unexpired one, or refuse past N), and never issue on HEAD.
- The 10-keys-per-user and 20-live-tokens-per-grant caps are list-then-create, so parallel requests exceed them
  slightly. Make them atomic (conditional insert) or re-check after insert and roll back.

## Acceptance criteria
- [ ] 100 GETs of a token-form page leave at most N `ui-once:` rows for the user; HEAD writes none.
- [ ] 30 parallel `POST /me/tokens` leave at most 20 live tokens (memory, SQLite, D1).

## Security notes
T20 (resource exhaustion by authenticated users).

## Docs to update
- `docs/dev/admin-ui.md` (`issueOnce`), THREAT_MODEL T20.

## Out of scope
- A shared (cross-isolate) per-user rate limit (P7-10).
