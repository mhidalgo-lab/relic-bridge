# 0011 — OAuth provider state in the storage `kv` table on both runtimes

- Status: accepted (P5-01, 2026-10-05; partly supersedes the storage part of ADR-0009's spike outcome)
- Date: 2026-10-05

## Context
ADR-0009 (spike P0-08) runs `@cloudflare/workers-oauth-provider` on both runtimes: on Workers with a Workers KV
namespace (`OAUTH_KV`), on Node with a KV-compatible table in SQLite. Two findings since then:

- **Workers KV is eventually consistent and has no atomic read-and-delete.** The provider redeems an authorization
  code by reading the grant, checking the code and writing the grant back. Two concurrent redemptions of one code can
  both pass that check, and a write can take up to 60 s to reach other locations, so a replay seen elsewhere may still
  find the old grant. The Phase 4 review asked for codes and other single-use values to be kept in storage with
  single-use atomic reads (`kv.take`, P4-01), never in isolate memory.
- **The Free plan allows 1,000 KV writes a day** (ADR-0009's tightest limit; refreshes cost 2 writes each). D1 on
  Free allows 100,000 row writes a day.

The storage layer already has a Workers-KV-shaped `kv` table on every adapter (memory, SQLite, D1), with expiry, prefix
listing, an atomic `take`, a contract test suite and an hourly purge of expired rows (P4-09).

## Decision
- The provider's `env.OAUTH_KV` is an adapter over the storage `kv` table on **both** runtimes (SQLite on Node, D1
  on Workers), under the key prefix `oauth:`. Key metadata is not stored (the provider then reads the grant record
  instead: correct, one extra read per grant of that user during re-authorization).
- Authorization codes are made single-use by relic-bridge: approval writes `oauth-code:<sha256(code)>`, the token
  endpoint consumes it with `kv.take` before the provider sees the code. A replayed code is refused and the grant it
  was issued for is revoked (OAuth 2.1 §4.1.3).
- The `OAUTH_KV` binding stays declared but unused (removing it is an owner decision, see
  `docs/pending-decisions/phase-5.md`).

## Consequences
- One code path and one consistency model on Node and Workers; the same integration suite runs on memory, SQLite and
  D1 storage.
- An MCP request with an OAuth token costs one D1 read for the token (validation) plus the access resolution, inside
  the Free plan's 1,000 Cloudflare-service calls per invocation (ADR-0010). D1 daily row limits on Free (enforced since
  2026-09-01) replace the KV write limit as the ceiling; a refresh costs about three row writes.
- Throughput for OAuth state is bounded by D1's single-writer database; at personal and small-team scale this is far
  from a limit.
