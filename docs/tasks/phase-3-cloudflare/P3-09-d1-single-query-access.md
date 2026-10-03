---
id: P3-09
title: Resolve access in one D1 round trip
phase: 3
status: in-progress
priority: medium
depends_on: [P3-02]
adr: [0006, 0008, 0010]
owner: claude-agent
---

# P3-09 — Resolve access in one D1 round trip

## Goal
On an access-cache miss the Worker currently makes five D1 reads in three round trips (token by hash; project +
grant; user + credential; sometimes the credential owner) plus the throttled `last_used_at` write. Each round trip
is network latency on the request path. Load everything a request needs with one D1 call, so a miss costs one read
call, without changing a single access decision.

## Scope
- **Storage**: optional capability `Storage.loadAccessRecords({ tokenHash, projectSlug })` returning the token,
  project, grant, grant user, credential and credential owner rows (`AccessRecords`). Contract:
  - no token with this hash → every field `null`;
  - `project` is looked up by slug (`null` slug → `null`); `grant` is the token's grant;
  - user, credential and credential owner are loaded **only** when the grant belongs to that project (T2: nothing
    else of a grant of another project is read), the credential being `grant.credentialId ??
    project.defaultCredentialId` and the owner only when it is not the grant's user.
  - The SQL lives once in `@relic-bridge/storage` (`ACCESS_RECORDS_SQL`), bound parameters only.
- **D1**: one `batch()` call (one round trip, one read transaction). **SQLite**: the same statements inside one
  read transaction. `memory` and `yaml` don't implement it and keep the current path.
- **Auth**: `authenticateAccess()` = token check + access resolution in one function. With the capability it makes
  one storage call; without it, it runs today's `verifyAccessToken` + `resolveAccess` unchanged. Both paths share the
  same pure steps (token-record check, project/grant pre-checks, `computeAccess`), so the decision function is
  untouched. Offline format/checksum refusals still read nothing; a malformed slug never reaches the query as a slug.
- **HTTP app** uses `authenticateAccess()`; the throttled `last_used_at` write is kept (reconsidered below).
- **Touch write reconsidered**: kept as is — it is already off the response path (`waitUntil` / background), at most
  one per token per 5 minutes from the stored value, and folding it into the read batch would turn every miss into
  a write transaction on the D1 primary. Documented.

## Acceptance criteria
- [ ] `loadAccessRecords` in the storage contract suite (sqlite on Node, D1 inside workerd), including the T2 rule,
      service grants, project default vs grant credential, owner = grant user, unknown token / slug.
- [ ] D1 implementation is exactly one `batch()` call; Workers test through the Worker: access resolution = 1 D1
      read call on a cache miss (plus the throttled touch write), 0 calls on a hit.
- [ ] Equivalence tests (fast-check, random worlds with disabled / revoked / expired / unvalidated / missing states,
      random tokens and slugs including unknown and malformed): the one-call path returns the same result as
      `verifyAccessToken` + `resolveAccess` (deny stage and reason, effective access, credential record, token id,
      expiry, touch due) on sqlite (Node) and D1 (workerd).
- [ ] No new timing distinction: an unknown token and a known-but-denied token both cost one storage call (today:
      one vs. up to three round trips).
- [ ] The P2-12 authz suite still passes on Node and on the Worker.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build` pass.

## Security notes
Same decision function (`computeAccess`) and the same pre-checks; only the loading changes. T2 (no reads for another
project's grant is now a join condition), T15 (cache unchanged), T19 (token checked before slug in the decision order).

## Docs to update
- `docs/dev/storage.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Monotonic `last_used_at` (`max(stored, now)`) — residual race already documented in T1/T15.
