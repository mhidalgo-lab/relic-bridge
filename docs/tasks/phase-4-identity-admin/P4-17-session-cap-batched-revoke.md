---
id: P4-17
title: "Cap live sessions per user and revoke them in bounded batches"
phase: 4
status: review
priority: medium
depends_on: [P4-02]
adr: []
owner: claude-agent
---

# P4-17 — Cap live sessions per user and revoke them in bounded batches

## Goal
Every sign-in adds a session and `revokeUserSessions` (`packages/auth/src/identity/session.ts`) lists the prefix and
deletes two rows per session, one storage call each. A user with many live sessions (a compromised IdP account can
create them quickly) makes *sign out everywhere*, unbind (which revokes first) and role changes cost 2N+1 D1 queries,
which can fail half-way on Workers Free (phase 4 review L5). The 1,005-session unit test also runs over Vitest's 5 s
default under load.

## Scope
- Cap live sessions per user (for example 20): at sign-in, evict the oldest beyond the cap.
- Revoke with one `DELETE … WHERE key LIKE ?` (or a bounded `batch`) per adapter instead of 2N calls; keep the
  index row and session row consistent.
- Settle the contradiction between `docs/RESEARCH.md` (D1 calls count against the 1,000 Cloudflare-services subrequests
  since 2026-02-11) and the "50 D1 queries per invocation on Free" comments in `apps/worker/src/worker.ts` and
  THREAT_MODEL T7 (P3-15's `batchSize` clamp). Cite the current Cloudflare limits page in RESEARCH.
- Give the revoke-many test an explicit timeout or make it fast.

## Acceptance criteria
- [x] Sign-in number cap+1 evicts the oldest session (unit + workers pool).
- [x] Revoking 1,000 sessions makes a constant number of storage calls (counted in the D1 test).
- [x] RESEARCH, worker comments and THREAT_MODEL agree on D1 per-invocation limits, with a source.

## Security notes
T13 (session revocation must be reliable), T20 (unauthenticated or cheap work amplification).

## Docs to update
- `docs/guide/admin-access.md` (session cap), `docs/RESEARCH.md`, THREAT_MODEL T7/T13.

## Out of scope
- A session list screen (pending decision P4-15).
