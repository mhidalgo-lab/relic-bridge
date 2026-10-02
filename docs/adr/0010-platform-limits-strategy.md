# 0010 — Budgets, concurrency and retries for Workers and NerdGraph limits

- Status: accepted (local measurements from spike P0-06; production CPU and live NerdGraph numbers pending)
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
