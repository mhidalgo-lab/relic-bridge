---
id: P6-14
title: "Fuzzy entity-name resolution with per-credential cache"
phase: 6
status: done
priority: medium
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-14 — Fuzzy entity-name resolution with per-credential cache

## Goal
Let users say "shippingservice" instead of an exact entity name or GUID (idea from prior-art: adjohn).

## Scope
- `resolveEntity` (shared resolver, `packages/core/src/tools/entity-resolver.ts`) and one new read-only tool,
  `resolve_entity`, that turns a loose name or a guid into one entity or a short candidate list. Match tiers, best first:
  exact guid (decoded offline, account checked before any request), exact name, case-insensitive name, normalised name
  (lower case, only letters and digits: `Shipping-Service` = `shippingservice`), substring of the normalised name. The best
  non-empty tier decides: one entity resolves, several return up to 10 candidates (never a silent pick), none says so.
- Lookup: a server-side `name LIKE` search (built only with `entityQuery`, scoped to the effective accounts, optional
  `domain`/`type`/`account`), and when that finds nothing a bounded name catalogue scan (at most 3 pages of 200) matched
  locally. Both lists are cached per credential id + region + effective account set + filters (+ query text), TTL 5 minutes,
  bounded LRU, per tool-set instance, never shared (T16, T21). Cached rows are re-filtered against the request's accounts.
- CPU is bounded: at most 600 names are normalised and compared per call.
- Extending the other entity tools (`get_entity`, `get_golden_metrics`, ...) to accept a name is a follow-up (P6-17);
  this task ships the resolver and the tool they will call.

## Acceptance criteria
- [x] `resolve_entity` and the exported `resolveEntity` implement the tiers above; guid input needs no request.
- [x] Ambiguity returns candidates (capped, with total) and never picks one.
- [x] Cache: TTL, LRU bound, key = credential id + region + accounts + filters; a grant with fewer accounts on the same
  credential never sees entries of a wider grant (tests incl. HTTP isolation).
- [x] Allowed-account filtering on fresh and cached data; out-of-scope guid and account refused offline.
- [x] Names are cleaned (`cleanName`) and shown inside the untrusted-data envelope; injection-shaped names are inert.
- [x] Contract sample call, authz `TOOL_CASES`, e2e tool count, `pnpm bench:cpu` stays green; docs regenerated.

## Security notes
T3, T16. Entity names are untrusted text (T6) — escape in entity search (P1-08 helper).

## Docs to update
- Tool reference.

## Out of scope
- Cross-account search beyond the grant's accounts.
