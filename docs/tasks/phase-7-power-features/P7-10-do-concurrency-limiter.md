---
id: P7-10
title: "Durable Object concurrency limiter for shared keys"
phase: 7
status: done
priority: low
depends_on: [P6-13]
adr: [0010]
owner: claude-agent
---

# P7-10 — Durable Object concurrency limiter for shared keys

## Goal
On Workers every isolate has its own NerdGraph semaphore and its own rate-limit buckets, so a key shared by many
clients can run `isolates x RB_CONCURRENCY` NerdGraph calls at once (New Relic limits concurrency per user, RESEARCH
§2), and the security throttles that the Rate Limiting binding cannot express (auth failures, sign-in, OAuth, writes)
are per isolate only. An optional Durable Object gives exact counters shared by every isolate.

## Scope
- **`SharedLimiter` Durable Object class** (`apps/worker/src/shared-limiter.ts`, SQLite-backed, exported from the
  Worker entry), addressed by name:
  - `concurrency:<credential id>` (the storage id, or the HMAC fingerprint id for pass-through keys; never the key):
    a semaphore with `acquire(max, leaseMs, waitMs)` / `release(lease)`. Waiters queue FIFO inside the object up to
    `waitMs`; every slot is a **lease** that expires (`leaseMs`, longer than the NerdGraph timeout) so a crashed or
    cancelled isolate never holds a slot for good. Leases are in memory: an evicted object forgets them (fails open).
  - `<rate-limit key>` (e.g. `fail:<ip>`): one token bucket with `take(rule, cost)` / `peek(rule)` (same arithmetic as
    `MemoryRateLimiter`, shared as a pure function), persisted in the object's storage so eviction does not reset it;
    an alarm deletes the stored bucket once it is full again (no storage left behind per IP).
- **Opt-in:** `RB_SHARED_LIMITER=off` (default) / `rules` / `on` plus the `SHARED_LIMITER` binding.
  `rules`: the rate-limit namespaces that are per isolate today (`fail:`, `signin:`, `oauth:`, `write:`) are counted
  by the object. `on`: also the NerdGraph concurrency per credential (normal and pass-through routes). The binding is
  declared in `wrangler.jsonc` (namespace costs nothing until used); without it the Worker warns and keeps today's
  behaviour.
- **Failure policy:** an object that cannot be reached (outage, Free-plan daily limit) never blocks: rate rules
  degrade to the isolate bucket (still a limit, today's behaviour), concurrency degrades to the isolate semaphore.
  A queue that does not free a slot within `waitMs` answers `RB_LIMIT_RATE` (no NerdGraph call is made).
- `packages/http-app`: optional `sharedConcurrency` hook (web-standard) composed with the isolate semaphore.
- `pnpm cf:setup --shared-limiter[=rules|on]` sets `RB_SHARED_LIMITER` (fake runner tests only).
- Docs: Cloudflare limits guide (cost, Free plan, failure policy), configuration reference, RESEARCH (Durable Objects
  facts), THREAT_MODEL (T1/T20 per-isolate notes), pending decisions of phases 3/4/5/7.

## Acceptance criteria
- [x] 20 parallel tool calls with one key through 4 simulated isolates (separate Worker instances sharing the
      binding, in workerd) never exceed `RB_CONCURRENCY` NerdGraph calls in flight and get no NerdGraph 429 from a mock
      that answers 429 above that; without the object the same load exceeds it (baseline).
- [x] Durable Object tests with real stubs in the workers pool: FIFO slots, lease expiry frees a slot, wait timeout,
      release of an unknown lease is harmless, buckets survive eviction, the cleanup alarm deletes a full bucket.
- [x] `WorkersRateLimiter`: `fail:`/`signin:`/`oauth:`/`write:` shared across limiter instances (take and peek);
      an unreachable object falls back to the isolate bucket; other namespaces unchanged.
- [x] Boot: off by default, `rules`/`on` without the binding warn and fall back, invalid values refused.
- [x] `cf:setup --shared-limiter` tested with the fake runner; `bench:cpu` unchanged (round trips are not CPU).
- [x] Docs and THREAT_MODEL updated; pending decisions of P3-04, P4-07/P4-20, P5-01/P5-10, P7-09 note "P7-10
      addresses this".
- [ ] Measured on a deployment: NerdGraph 429s gone under a real 20-client load; added latency per call (needs a
      deploy; not done in the autonomous run).

## Security notes
T1 (auth-failure throttle becomes deployment-wide), T20 (abuse limits exact across isolates), T21 (object state holds
counters only: rate keys and credential ids, never keys or request data), T31 (write limit exact). Object names never
contain a New Relic key.

## Docs to update
- `docs/guide/cloudflare-limits.md`, `docs/guide/cloudflare-deploy.md`, `docs/guide/configuration.md`,
  `docs/RESEARCH.md`, `docs/THREAT_MODEL.md`, pending decisions.

## Out of scope
- Moving `ip:`/`token:`/`grant:`/`key:` from the Rate Limiting binding to the object (one more round trip on every
  request; the binding is free). A follow-up if exact per-request limits are wanted.
- Persisting concurrency leases in storage (two writes per NerdGraph call).
