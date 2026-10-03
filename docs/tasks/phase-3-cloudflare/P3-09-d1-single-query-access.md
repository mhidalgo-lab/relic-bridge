---
id: P3-09
title: Resolve access in one D1 round trip
phase: 3
status: todo
priority: medium
depends_on: [P3-02]
adr: [0006, 0010]
owner: ""
---

# P3-09 — Resolve access in one D1 round trip

## Goal
On an access-cache miss the Worker currently needs about four D1 round trips (token by hash; project + grant;
user + credential; sometimes the credential owner). Each is a subrequest-like call with network latency. Load
everything a request needs with one joined query (or one `batch()`), so a miss costs one D1 call.

## Scope
- Optional `Storage` capability (for example `loadAccessRecords(tokenHash, slug)`) returning the token, project,
  grant, user, credential and credential owner rows; adapters without it keep the current path.
- D1 implementation as one statement (joins) or one `batch()`; `verifyAccessToken` + `resolveAccess` use it when
  present, with the same deny reasons and the same "no reads for a grant of another project" rule (T2).

## Acceptance criteria
- [ ] Workers test: access resolution = 1 D1 call on a cache miss, 0 on a hit.
- [ ] The P2-12 authz suite still passes on every adapter.

## Security notes
Same decision function (`computeAccess`); only the loading changes. T2, T15.

## Docs to update
- `docs/dev/storage.md`.

## Out of scope
- —
