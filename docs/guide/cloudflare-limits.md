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
separate allowance of 1,000 per request on Free. An access-cache miss costs one D1 call (a batch of reads) plus at
most one background `last_used_at` write per token every 5 minutes; a hit costs none.

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

The repository benchmarks these paths in CI against a committed baseline (`pnpm bench:cpu`, see `docs/dev/testing.md`)
so a change that makes a call much more expensive is noticed before it reaches a Free account. It runs in a local
workerd, so its absolute numbers are higher than production and only the trend matters.

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

## Rate limiting on Workers

relic-bridge applies the same rate limits as on Node (per IP 600/min, failed authentications per IP 10 per 5 min, per
token 120/min, per grant 300/min unless the grant sets its own, per pass-through key 120/min), in two layers:

| Layer | What it does | Weakness |
|---|---|---|
| Per-isolate token bucket | Enforces the exact rule (including a grant's own `rateLimit`) with no I/O; provides the "peek" the auth-failure throttle needs. | Each isolate counts alone, so the effective limit is up to (isolates x limit). |
| Workers Rate Limiting binding `RATE_LIMITER` (`ratelimits` in `wrangler.jsonc`, default 600 per 60 s per key) | Shared backstop for the `ip:`, `token:`, `grant:` and `key:` buckets; a refusal answers `429` with `Retry-After: 60`. | One fixed limit and period (10 or 60 s) per binding; counted per Cloudflare location and eventually consistent, so it is permissive by design; cannot be peeked. |

- **Auth-failure throttle** is per isolate only: the binding cannot report a count without consuming, so failed
  authentications are not shared across isolates or locations. An attacker spread over many isolates gets more guesses
  than on Node, but tokens carry 256 bits of entropy and every 401 stays identical. The Durable Object limiter (P7-10)
  closes this gap. Known side effect, unchanged from Node: a shared IP that fails 10 times is refused even with a valid
  token (Phase 2 review M6, still open).
- **Client address** is `CF-Connecting-IP`, which Cloudflare sets and clients cannot override. Requests without it
  share one `unknown` bucket.
- **Fail open:** if the binding throws, the request is allowed and an error is logged; authentication still applies.
- To tighten the shared backstop, change `limit`/`period` of the `RATE_LIMITER` entry in `wrangler.jsonc`.
  `RB_RATE_LIMIT=off` turns all of it off (not recommended).
- Without the binding the Worker still starts (isolate buckets only) and logs a warning.

### Optional: a WAF rate-limiting rule in front

Cloudflare's own rate limiting runs before the Worker is invoked, so refused requests cost no Worker request. It needs a
zone (a custom domain), not a `workers.dev` name. In the dashboard: *Security > WAF > Rate limiting rules > Create rule*.

| Field | Suggested value |
|---|---|
| If incoming requests match | URI Path starts with `/p/` or equals `/passthrough/mcp` or starts with `/oauth` |
| Characteristic | IP |
| Requests / period | 100 per 10 seconds |
| Action | Block for 1 minute (or Managed Challenge is not suitable: clients are not browsers) |

The rule is an addition, not a replacement: it cannot see tokens or grants.

### Pass-through on Workers

`RB_PASSTHROUGH=on` enables `/passthrough/mcp` on Workers. Because per-key limits must be shared, boot fails (503, the
log names the variable) unless:

1. `RB_FINGERPRINT_SECRET` is set: `openssl rand -base64 32 | wrangler secret put RB_FINGERPRINT_SECRET`. Every isolate
   hashes a New Relic key with this secret, so one key maps to one limiter bucket everywhere. Without a shared
   secret each isolate would have its own random one. Keep it like the master key: changing it only resets counters.
2. The `RATE_LIMITER` binding is present, and `RB_RATE_LIMIT` is not `off`.
