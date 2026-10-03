# 0010 — Budgets, concurrency and retries for Workers and NerdGraph limits

- Status: accepted (spike P0-06 local + production measurements, P0-09 live NerdGraph run)
- Date: 2026-10-01

## Context
See RESEARCH §1–2: Workers Free = 10 ms CPU, 50 subrequests (D1/KV count), 6 pending connections. NerdGraph =
25 concurrent per NR user, 429 on excess, NRQL 3,000/min/account, 5 s default timeout.

## Decision
- **Subrequest budget** object per invocation (`RB_PLAN=free|paid` presets, overridable). Tools declare their expected
  cost; combined report tools stop early and return a partial result with a `budget_exhausted` note.
- **Concurrency limiter** per credential: default 5 NRQL in flight (≤ 6 on Workers). Phase 7 adds an optional Durable
  Object limiter for shared keys across isolates.
- **Retries**: on 429 / 5xx / network errors, retry with exponential backoff + full jitter, max 3 attempts, all within budget.
  NerdGraph GraphQL `errors` aren't retried unless they're marked transient.
- **Timeouts**: every NRQL call passes an explicit `timeout`. Long queries use `async: true`; polling respects
  `retryAfter` and the budget, then returns a `queryId` handle.
- **CPU discipline**:
  - cap the response size *before* `JSON.parse`
  - SHA-256 token hashing (no slow KDF on the hot path)
  - import keys once per isolate
  - streaming / limited formatting
- **Isolate caches** (grant resolution, decrypted CryptoKey objects — never plaintext NR keys longer than a request) with TTL ≤ 60 s.

## Consequences
- The free plan is viable for personal use; the docs say when to move to Workers Paid.

## Spike P0-06 outcome (2026-10-01, local)

Warm hot-path CPU (Hono → SDK v2 → tool; measured in Node with the same V8, cross-checked against local workerd):

| NerdGraph response | p50 | p95 |
|---|---|---|
| 10 KB | 1.8 ms | 6.8 ms |
| 100 KB | 2.9 ms | 5.8 ms |
| 1 MB | 6.8 ms | 17.3 ms |
| 5 MB | 33.6 ms | 63 ms |

Body read and parse dominate at about 5 ms/MB. Hashing, AES-GCM and shaping each take under 0.3 ms. A typical call uses 2 subrequests
(1 with a cached access lookup), plus about 1 for the audit write.

**Provisional presets:**

| Setting | `RB_PLAN=free` | `RB_PLAN=paid` |
|---|---|---|
| `maxResponseBytes` (enforced while streaming, before parse) | 512 KiB | 8 MiB |
| Subrequest budget | 50 (tools plan ≤ 40) | 1000 |
| Concurrency | ≤ 5 | ≤ 5 |
| Access-token TTL (ADR-0009) | 8 h | 1 h |

**Open risk:** cold-isolate CPU (first SDK request compiles schemas: 66–163 ms in Node, smaller in workerd). Only a
production free-plan deployment can show whether cold calls exceed the limit. This must be measured before P3-03 finalises the presets.

## Production measurements (P0-06, 2026-10-02)

| Response | CPU p50 | CPU p90 | CPU p99 |
|---|---|---|---|
| 10 KB | 2.8 ms | 3.7 ms | 24.6 ms |
| 100 KB | 3.7 ms | 6.6 ms | 20.5 ms |
| 1 MB | 10.2 ms | 14.9 ms | 39.7 ms |
| 5 MB | 45.8 ms | 54.1 ms | 61.9 ms |

Cold first call: 17–35 ms CPU (n=5). **No request was terminated on the Workers Free plan** (confirmed by the maintainer;
Workers Logs show `cpuTimeMs` up to 61 ms with `outcome: ok`). Free tolerates overruns in practice but it isn't guaranteed,
so we don't rely on it. The presets above stand: 512 KiB keeps warm calls at about 5 ms. NerdGraph latency for
lean queries is ~230–470 ms (P0-09), so wall time is dominated by NerdGraph, not by the Worker.

## Final presets (P3-03, 2026-10-03)

Cloudflare changed subrequest accounting on 2026-02-11: on Free, **external** `fetch` calls are limited to 50 per
invocation and calls to Cloudflare services (D1, KV, ...) have a separate allowance of 1,000. The budget therefore
counts NerdGraph calls only, and D1 queries no longer compete with it. Free also has enforced D1 daily row limits since
2026-09-01.

| Setting | `free` | `paid` |
|---|---|---|
| `callBudget` (`RB_CALL_BUDGET`) | 45 (50 minus 5 for redirects) | 1000 (platform default 10,000) |
| `maxResponseBytes` ceiling (`RB_MAX_RESPONSE_BYTES`) | 512 KiB | 8 MiB |
| Concurrency (`RB_CONCURRENCY`, 1-6) | 5 | 5 |

Tools whose `cost` exceeds the budget are not registered; `whoami` explains. The response ceiling caps a project's own
limit. The remaining provisional-table rows (access-token TTL) are ADR-0009's and unchanged. Cold-isolate CPU was measured in
P0-06 (17-35 ms, no kills on Free), so the open risk above is accepted as documented.

