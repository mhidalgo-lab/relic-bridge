---
id: P8-19
title: Include APM deployments in account-scope list_change_events and fill type
phase: 8
status: in-progress
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-19 — Include APM deployments in account-scope list_change_events and fill type

## Goal
In the live test run (2026-10-12, BUG-09) account-scope `list_change_events` returned `[]` while the entity-scoped deployment search returned recorded deployments, and returned events had `type: null`. Account scope must show APM deployments, and `type` must be filled.

## Scope
- Account scope: besides the account change feed, enumerate the account's APM applications (bounded: 50, two batched requests of 25 guids) and merge their deployment search results; dedupe against the feed; say in `notes` when applications were not checked or the lookup failed.
- `type`: fall back to the `categoryAndType` suffix, then `category`, then `DEPLOYMENT` for deployments.
- Tool description, RESEARCH.md, THREAT_MODEL row updated.

## Acceptance criteria
- [ ] Account scope returns the deployments of the account's APM applications, newest first, merged with the feed.
- [ ] Every guid used is checked against the requested account; deployments naming another entity are dropped.
- [ ] `type` is never null for deployments and typed events.
- [ ] Limits (more than 50 applications, failed lookup) are reported in `notes` and the text output.
- [ ] Regression tests fail before the fix, pass after; changeset added.

## Security notes
T3: account-scope deployments come from entities found by an account-filtered search and are re-checked (account, GUID agreement, entity match). Values stay GraphQL variables (T4).

## Docs to update
- docs/RESEARCH.md, docs/THREAT_MODEL.md, docs/reference/tools.md (generated), task index.

## Out of scope
- Other live-run bugs (separate tasks).
