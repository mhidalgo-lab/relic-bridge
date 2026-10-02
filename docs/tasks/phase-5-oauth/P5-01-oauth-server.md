---
id: P5-01
title: "OAuth 2.1 authorization server integration"
phase: 5
status: todo
priority: high
depends_on: [P4-08]
adr: [0009]
owner: ""
---

# P5-01 — OAuth 2.1 authorization server integration

## Scope
- Port the P0-08 spike (`spikes/oauth/`) e2e suite into CI for both runtimes; per-request AS/RS construction cached by project-list version; opaque user ids (T25).
- Implement per ADR-0009 outcome of P0-08: `workers-oauth-provider` on Workers; Node via KV adapter or `oidc-provider` behind the same interface.
- Token props carry `grant_id`, `project_slug`, `user_id`, `client_id`.
- Bearer tokens (P2-05) keep working alongside OAuth.

## Acceptance criteria
- [ ] Same OAuth integration test suite passes on Node and Workers.

## Security notes
T9, T10, T12.

## Docs to update
- `docs/dev/oauth.md`.

## Out of scope
- —
