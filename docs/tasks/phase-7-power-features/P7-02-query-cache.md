---
id: P7-02
title: "Query cache (Cache API / in-memory LRU)"
phase: 7
status: review
priority: medium
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-02 — Query cache (Cache API / in-memory LRU)

## Goal
Repeated NRQL (an agent re-asking, `detail: "full"` after a summary, composites sharing a query) is answered without a
New Relic call, without ever serving one tenant's, credential's or grant's results to another (THREAT_MODEL T16).

## Scope
1. **One cache in the NRQL engine** (`runNrql` / `runRawNrql` / `runTrustedNrql`): every tool that runs NRQL benefits.
   Only `complete` outcomes are cached; pending handles, errors and `get_query_result` polls never are. Lookups run
   *after* account resolution and query-limit enforcement, so a query the current grant may not run is refused before
   the cache is consulted.
2. **Key** = keyed hash (HMAC-SHA-256) over a length-prefixed, versioned encoding of: cache scope (stdio / grant id /
   pass-through), credential id, region, a SHA-256 fingerprint of the NR key (key rotation or a different pass-through
   key never hits), the effective account list, a fingerprint of every query limit (max LIMIT, window, event-type
   allow/deny, rawNrql, response cap), the stats flag, the normalised NRQL actually sent (whitespace between tokens
   collapsed, nothing else changed) and the time bucket. No NR key, token or raw NRQL appears in a cache key or URL.
3. **TTL rules**: relative or open-ended windows (`SINCE 30 minutes ago`, calendar keywords, no UNTIL, subqueries)
   get a short TTL (default 30 s, max 300 s) *and* a time bucket of that length in the key; windows with absolute
   SINCE and UNTIL that ended at least 15 minutes ago (late data settled) get a longer TTL (default 10 min, max 1 h).
4. **Stores**: a bounded in-memory LRU (entries and bytes) on Node and per Workers isolate; on Workers additionally
   the per-colo Cache API (`caches.open`) under a synthetic `https://query-cache.relic-bridge.invalid/v1/<hmac>` URL,
   bodies AES-GCM encrypted with a key derived from the master key (AAD = the entry id), `Cache-Control: max-age`
   only (no `public`), expiry re-checked on read. Cache API calls spend the request budget (they share the subrequest
   quota) and are skipped when the budget can't pay for them. Store failures are misses, never tool errors.
5. **Size caps**: entries above `maxEntryBytes` (default 256 KiB) are not stored; memory LRU default 500 entries /
   16 MiB.
6. **Controls**: `RB_QUERY_CACHE=on|off` (default on) and `RB_QUERY_CACHE_TTL` (relative TTL seconds) for `serve`,
   stdio and the Worker; `run_nrql` takes `cache: "bypass"` to force a fresh query (the fresh result refreshes the
   entry).
7. **Output**: `_meta["relic-bridge/result"].cache` = `{ status: hit|miss|bypass|off, store?, ageSeconds?,
   ttlSeconds? }`; a cache hit adds one line ("Served from the query cache, N s old") outside the envelope (our text).
   Rows still go through the untrusted-data envelope and redaction (cached entries are the raw NRQL outcome, shaped
   per call).
8. **T21**: the cache object lives in the host runtime (process / isolate), not in module state, and is handed to
   tools through `ToolContext.queryCache`; it holds results keyed by the isolation key above, never credentials.

## Acceptance criteria
- [x] Task refined (this file) before implementation.
- [x] Never shared across credentials, keys (rotation / pass-through), regions, grants/projects, account sets or
      query limits (tests in core; HTTP test across two grants and two pass-through keys).
- [x] Relative windows expire within the short TTL; absolute settled windows use the long TTL; clock going back is a
      miss (tests).
- [x] Size caps: oversized entries are not stored; the LRU stays within entries and bytes (tests).
- [x] Workers Cache API store works in the workers pool (encrypted body, expiry, budget spent) and isolates tenants.
- [x] `cache: "bypass"`, `RB_QUERY_CACHE=off` and `cache` meta tested; cache hits spend no NerdGraph budget.
- [x] THREAT_MODEL T16 updated; configuration reference documents the variables.

## Security notes
**T16**, T21, T4 (keys carry no secrets), T5 (limits enforced before lookup).

## Docs to update
- Configuration reference (`docs/guide/configuration.md`), THREAT_MODEL T16, ARCHITECTURE (cache), tools reference.

## Out of scope
- Result paging by handle (decision logged in `docs/pending-decisions/phase-7.md`).
- Cross-colo / KV-backed cache, cache purge API.
