# Cloudflare limits and plan presets

On Cloudflare Workers, relic-bridge adapts to the plan you run on. Set `RB_PLAN=free` (default) or `RB_PLAN=paid`
in `vars`; each plan is a preset you can override one number at a time. Sources and measurements:
[RESEARCH §1](../RESEARCH.md), [ADR-0010](adr/0010-platform-limits-strategy.md).

## Presets

| Setting | `free` | `paid` | Variable to override | Why |
|---|---|---|---|---|
| NerdGraph calls per MCP request | 45 | 1000 | `RB_CALL_BUDGET` | Free allows 50 external subrequests; 5 spare for redirects. Retries and async polls spend from it. |
| Response size ceiling | 512 KiB | 8 MiB | `RB_MAX_RESPONSE_BYTES` | Reading and parsing a body costs about 5 ms CPU per MB; Free has 10 ms. Applied while streaming, before parse. |
| NerdGraph calls in flight per credential | 5 | 5 | `RB_CONCURRENCY` | Workers allows 6 simultaneous outgoing connections per request; the value is limited to 6. |

D1 and KV calls (token lookup, access resolution, audit rows) do **not** use the 50: Cloudflare counts them against a
separate allowance of 1,000 per request on Free. An access-cache miss costs about 5 D1 reads and 1 write in total
(P3-09 will reduce the round trips); a hit costs none.

A project's own `maxResponseBytes` still applies; the smaller of the two wins. Overrides that are malformed or out of
range stop the Worker booting (it answers `503` and logs which variable is wrong). A Free deployment configured past
the platform limits logs a warning at start.

## What happens at the limits

- **Budget runs out mid-call:** tools return what they have. `run_nrql` stops polling and returns the query handle
  (`status: pending`, use `get_query_result` later); `get_golden_metrics` marks the metrics it could not start as
  skipped. Anything else is a normal tool error with `RB_BUDGET_EXHAUSTED` and a hint, never an HTTP 500.
- **Tool too expensive for the budget:** a tool whose declared cost is above `RB_CALL_BUDGET` is not offered at all,
  and `whoami` lists it under "Not offered here" with the reason. With the presets this never happens
  (the most expensive tool, `get_golden_metrics`, needs 11).
- **Response too large:** `RB_LIMIT_RESPONSE_TOO_LARGE`; narrow the query (fewer rows or attributes, shorter window).
- **D1 daily quota (Free: 5 M rows read, 100 k rows written):** Cloudflare fails D1 queries until 00:00 UTC. Reads fail
  closed (503); audit writes are logged and skipped.

## What fits on Free

Measured on a real Free Worker (P0-06): warm CPU per call is about 3 ms for 10-100 KB of NerdGraph response and about
10 ms for 1 MB; a cold isolate adds 17-35 ms once. Cloudflare tolerated overruns up to 61 ms without killing requests
during the spike, but that is not a guarantee, so the Free preset keeps calls near 5 ms.

| Tool / payload | Free | Notes |
|---|---|---|
| `whoami`, `list_accounts`, `time` | fine | 0-1 calls |
| `search_entities`, `get_entity`, schema tools | fine | 1-2 calls, small responses |
| `run_nrql` up to 512 KiB (about 200 rows of a typical result) | fine | 1 call, plus up to 3 polls for slow queries |
| `run_nrql` returning more than 512 KiB | refused | Narrow the query, or move to Paid |
| `get_golden_metrics` (up to 10 metrics) | fine | 11 calls out of 45; partial result if the budget is short |
| Several tool calls in parallel from one client | fine | Each MCP request has its own budget |
| Payloads of 1-8 MiB | Paid | Raise the ceiling only with `RB_PLAN=paid` (CPU about 10-45 ms) |

Move to Workers Paid for large result sets, shared teams or heavy use; it also lifts the 100,000 requests per day
and 10 ms CPU limits.
