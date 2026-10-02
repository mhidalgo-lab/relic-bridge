# P0-06 results: Workers free-plan CPU and subrequest budget

Status: **local measurements done; production measurement pending** (needs the owner's Cloudflare account, see
[`deploy-and-measure.md`](deploy-and-measure.md)). Date: 2026-10-01. All data synthetic.

## Method

The Worker in `src/worker.ts` simulates one relic-bridge tool call end to end:

1. Hono middleware: `Authorization: Bearer` → SHA-256 → **one D1 query** (token ⨝ credential).
2. SDK v2 `createMcpHandler(factory, { legacy: 'stateless' })` builds a fresh `McpServer` per request with one tool, `run_nrql`.
3. The tool decrypts the stored key with AES-256-GCM. The master `CryptoKey` is imported once per isolate; AAD = `credential_id|version`.
4. **One fetch** to a mock NerdGraph (`src/mock-nerdgraph.ts`, a separate Worker behind a service binding, so payload
   generation isn't billed to the measured Worker). The request uses GraphQL variables.
5. The body is read as a stream with a byte cap (before `JSON.parse`), then parsed and shaped into a markdown table
   (200-row cap, 80-char cells).

Payloads are NRQL-shaped `Transaction` rows of ~10 KB, 100 KB, 1 MB and 5 MB.

Three local measurement setups:

- **A. Node cross-check** (`src/node-bench.ts`): same V8 engine, precise CPU via `process.cpuUsage()`. Runs each step and
  the **full Worker app** (`app.fetch` with fake D1/service bindings, so no I/O): 5 warm-up + 30 measured iterations.
- **B. workerd local** (`wrangler dev --local`, wrangler 4.143.0, workerd 1.20260926.1): `/bench` route timing each step
  with `performance.now()` (1 ms resolution locally), plus end-to-end wall time with `curl` (includes local D1 and the
  mock Worker).
- **C. Cold path**: first tool call in a fresh Node process (`src/node-cold.ts`) and the first call after a fresh `wrangler dev`.

## Local measurements

### A. Node (V8) CPU per step, warm, ms (p50 / p95)

| Payload | Token hash | AES-GCM decrypt | Capped body read | Parse + shape | **Full tool call** (Hono + SDK + tool) |
|---|---|---|---|---|---|
| 10 KB | 0.13 / 0.39 | 0.12 / 0.26 | 0.09 / 0.22 | 0.16 / 0.50 | **1.8 / 6.8** |
| 100 KB | 0.12 / 0.37 | 0.12 / 0.32 | 0.28 / 2.42 | 0.85 / 1.42 | **2.9 / 5.8** |
| 1 MB | 0.17 / 0.94 | 0.20 / 3.34 | 1.67 / 4.51 | 3.15 / 10.29 | **6.8 / 17.3** |
| 5 MB | 0.24 / 11.67 | 0.22 / 5.61 | 10.58 / 29.02 | 15.36 / 43.65 | **33.6 / 63.3** |

`process.cpuUsage()` is process-wide, so p95 includes GC and background threads (noisy). Treat p50 as the signal.

### B. workerd local

In-isolate `/bench`, average of 10 iterations (ms, 1 ms timer resolution): parse + shape 0.2 (10 KB), 0.7 (100 KB),
2.7 (1 MB), 18.1 (5 MB). Hash and decrypt read 0, i.e. below timer resolution.

End-to-end wall time per tool call, warm, 15 calls (ms, includes local D1 + mock Worker + curl, so an **upper bound** on CPU):

| Payload | p50 | p95 |
|---|---|---|
| 10 KB | 13.9 | 16.5 |
| 100 KB | 18.1 | 23.8 |
| 1 MB | 29.2 | 33.5 |
| 5 MB | 61.5 | 80.9 |

In-tool split at 5 MB: fetch + capped read 44 ms (wall), parse + shape 12 ms.

### C. Cold path (first call in a fresh isolate/process)

| Setup | First call | Warm calls after it |
|---|---|---|
| Node, fresh process, 10 KB (CPU) | **66–163 ms** (5 runs) | ~1.8 ms |
| Node split: our code only (hash + decrypt + parse) | ~6 ms | — |
| Node split: SDK first `tools/call` through `createMcpHandler` | **62–71 ms** | — |
| workerd local, fresh `wrangler dev`, 10 KB (wall) | **24–38 ms** (3 runs) | 11–23 ms |

The cold cost comes from the **MCP SDK's first request** (lazy compilation of the request path), not our code.
`preloadSchemas()` doesn't remove it in Node. In workerd the SDK's `_shims/workerd` entry already calls
`preloadSchemas()` at module scope, which counts toward startup time (1 s limit), not request CPU. That plausibly
explains why the cold delta there is only ~10–15 ms.

### Subrequests per tool call

| Path | Subrequests |
|---|---|
| Measured spike call | **2** (1 D1 lookup + 1 NerdGraph fetch) |
| With isolate cache hit on access resolution (ADR-0010) | 1 |
| + audit write (D1), + `last_used_at` (throttled) | +1, +0–1 |
| + each async NRQL poll | +1 each |
| Composite reports (P6-10), estimated | 10–20 |

The Free budget of 50 is comfortable for single tools and enough for composite reports with poll caps.

Caveat: a response header set after `next()` (`x-rb-subrequests`) reads **1** for streamed (SSE) MCP responses,
because headers go out before the tool finishes. Final counts must be recorded in the audit log or logs, not headers.

## Findings

1. **Warm calls fit the 10 ms Free CPU limit up to ~1 MB of NerdGraph response.** Our own work (hash, decrypt,
   shaping) is small. Cost scales with response size (body read + `JSON.parse` ≈ 5 ms/MB in V8). ≤ 100 KB costs ≈ 3 ms
   for the whole call; 1 MB ≈ 7 ms p50 with noisy tails; 5 MB (≈ 34 ms) clearly needs Workers Paid.
2. **Cold isolates are the real Free-plan risk.** The first request into a new isolate pays roughly 10–15 ms (workerd,
   wall, local) to 60+ ms (Node) of lazy SDK compilation. Cloudflare documents "some built-in flexibility … for cases
   where your Worker infrequently runs over the configured limit", so occasional cold overruns may pass, but this
   **must be measured in production** (watch for `outcome: "exceededCpu"` / HTTP 1102).
3. **SDK v2 works on workerd**: `createMcpHandler` with `legacy: 'stateless'` served a 2025-era `tools/call`
   without `initialize`, answering with `text/event-stream`. This is relevant to P0-07.
4. Subrequests aren't the binding constraint: 1–3 per typical tool call.

## Provisional recommendations

| Setting | `RB_PLAN=free` | `RB_PLAN=paid` |
|---|---|---|
| `maxResponseBytes` (cap enforced while streaming, before parse) | **512 KiB** (≈ 3–4 ms parse; headroom for cold-start overhead) | 8 MiB |
| Subrequest budget | 50 (platform max), with tools planning ≤ 40 | 1000 |
| Concurrency per invocation | ≤ 5 (≤ 6 platform connection limit) | ≤ 5 |
| Shaped output | 200 rows / 80-char cells (shaping cost is negligible vs. parsing) | same |

Likely to need **Workers Paid** (or degrade on Free with a clear "narrow your query" error):

- raw `run_nrql` returning > 512 KiB (e.g. `SELECT *` on `Log`, `Span`, `Transaction` without aggregation)
- `list_recent_logs` / log analysis over raw rows
- composite reports (P6-10) that parse several mid-size results in one invocation
- anything run on a cold isolate if production shows cold overruns are terminated

Aggregated NRQL (FACET / TIMESERIES / `percentile`) returns small payloads and is fine on Free.

Mitigations worth carrying into P1/P3:

- byte cap before parse (implemented here as `readCapped`)
- push agents toward aggregates through tool descriptions and query limits
- keep global-scope warm-up (schema preload, static tool definitions) out of the request path
- consider building the `McpServer` tool table once per isolate and filtering per grant, instead of re-registering
  tools on every request (verify that the SDK allows this safely; T21: no request data in module state)

## Still to verify on a real deployment

- [ ] Production CPU p50/p99 per payload size (dashboard or GraphQL `cpuTimeP50`/`cpuTimeP99`; unit believed to be µs)
- [ ] Cold-isolate first-call CPU in production, and whether Free terminates it (1102 / `exceededCpu`)
- [ ] Whether a CPU-time field appears in Workers Logs invocation logs (name not documented in the pages checked)
- [ ] Whether service-binding calls count as subrequests (docs checked don't say; count them conservatively)
- [ ] Real NerdGraph response sizes for typical queries (P0-09) to confirm the 512 KiB cap rarely bites

### Production measurements (fill in)

| Payload | CPU p50 (ms) | CPU p99 (ms) | 1102 / exceededCpu count (of 50) | Cold first-call CPU |
|---|---|---|---|---|
| 10 KB | | | | |
| 100 KB | | | | |
| 1 MB | | | | |
| 5 MB | | | | |

## Files

- `src/hotpath.ts`: hash, AES-GCM, synthetic payload, capped read, parse + shape, budget (web-standard)
- `src/worker.ts`: measured Worker (Hono + SDK v2 + D1 + service binding); `/seed` only when `ALLOW_SEED=1`
- `src/mock-nerdgraph.ts`: mock NerdGraph Worker
- `src/node-bench.ts`, `src/node-cold.ts`: Node cross-checks; `src/load.ts`: load generator for the deployed Worker
- `wrangler.jsonc`, `mock.wrangler.jsonc`: local configs (placeholder D1 id; no account ids)

Reproduce locally:

```sh
pnpm install
pnpm exec wrangler dev --local --port 18760 -c wrangler.jsonc -c mock.wrangler.jsonc
node src/node-bench.ts
node src/node-cold.ts
```

Local dev needs a `.dev.vars` file (gitignored) with `MASTER_KEY=<base64 32 bytes>` and `ALLOW_SEED=1`.
