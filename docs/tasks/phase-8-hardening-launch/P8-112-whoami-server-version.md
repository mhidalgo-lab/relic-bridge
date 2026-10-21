---
id: P8-112
title: Show the server version in whoami
phase: 8
status: todo
priority: low
depends_on: []
adr: []
owner: ""
---

# P8-112 — Show the server version in whoami

## Goal
Mobile retest (Claude Android, 0.13.0): a user could only tell which release served a call from relic-bridge's own
spans. Clients rarely show `serverInfo` from `initialize`. `whoami` should say which relic-bridge version answered,
and on which runtime (Node or Workers), so two deployments of one project can be told apart.

## Scope
- `whoami`: add an optional `server: { version, runtime }` to `structuredContent` (output schema stays backward
  compatible) and one text line, for example "relic-bridge 0.13.0 (workers)". Use the version the server already
  reports in `serverInfo`; never build it from request data.

## Acceptance criteria
- [ ] Tests for Node and Worker hosts: version and runtime present, schema validates.
- [ ] Generated tool docs regenerated.

## Security notes
Version disclosure to authenticated callers only (`/version` already exposes it). No new data.

## Docs to update
- Generated tool docs, changeset (patch).

## Out of scope
- Build hashes or commit ids.
