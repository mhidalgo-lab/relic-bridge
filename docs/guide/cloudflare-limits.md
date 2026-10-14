# Cloudflare limits and plan presets

On Cloudflare Workers, relic-bridge adapts to the plan you run on. Set `RB_PLAN=free` (default) or `RB_PLAN=paid`
in `vars`; each plan is a preset you can override one number at a time. Sources and measurements:
[RESEARCH §1](../RESEARCH.md), [ADR-0010](../adr/0010-platform-limits-strategy.md).

## Presets

| Setting | `free` | `paid` | Variable to override | Why |
|---|---|---|---|---|
| NerdGraph calls per MCP request | 45 | 1000 | `RB_CALL_BUDGET` | A per-call cap (one tool call), never a running total. Free allows 50 external subrequests; 5 spare for redirects. Retries and async polls spend from it. |
| Response size ceiling | 512 KiB | 8 MiB | `RB_MAX_RESPONSE_BYTES` | Reading and parsing a body costs about 5 ms CPU per MB; Free has 10 ms. Applied while streaming, before parse. |
| NerdGraph calls in flight per credential | 5 | 5 | `RB_CONCURRENCY` | Workers allows 6 simultaneous outgoing connections per request; the value is limited to 6. Counted per isolate unless `RB_SHARED_LIMITER=on` ([below](#shared-limiter-durable-object-optional)). |

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
| `get_golden_metrics` (up to 10 metrics) | fine | up to 41 calls out of 45 (two queries per metric); partial result if the budget is short |
| Several tool calls in parallel from one client | fine | Each MCP request has its own budget |
| Payloads of 1-8 MiB | Paid | Raise the ceiling only with `RB_PLAN=paid` (CPU about 10-45 ms) |

Move to Workers Paid for large result sets, shared teams or heavy use; it also lifts the 100,000 requests per day
and 10 ms CPU limits.

## Measured overhead and cost per tool

What relic-bridge itself adds to each tool call, and what a call costs in NerdGraph requests (the Workers external
subrequests that the 50 and 1,000 limits above count). Reproduce on your own machine with `pnpm bench` (Node and
workerd, no New Relic key needed; `pnpm bench --node` for Node only; about a minute). It is not part of CI.

Measured 2026-10-14 on Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz, 3 threads, 12 GiB; Node 24.16.0, workerd 1.20260926.1.
Mock NerdGraph (recorded fixtures, zero latency), in-memory MCP client, sample arguments from the contract tests.
**Indicative only**: the numbers depend on the machine, and local workerd is not production Workers.

| Tool | Node p50 / p95 (ms) | Workers p50 / p95 (ms) | NerdGraph requests | Declared cost | NerdGraph response (KiB) | Result (KiB) |
|---|---:|---:|---:|---:|---:|---:|
| `whoami` | 0.38 / 1.6 | 1.1 / 53.3 | 1 | 1 | 0.1 | 0.7 |
| `list_accounts` | 0.48 / 1.0 | 1.0 / 3.1 | 1 | 1 | 0.1 | 0.4 |
| `time_range` | 0.14 / 0.33 | 0.90 / 4.3 | 0 | 0 | 0.0 | 0.2 |
| `get_ui_link` | 0.20 / 0.52 | 0.90 / 3.0 | 0 | 0 | 0.0 | 0.4 |
| `run_nrql` | 0.68 / 2.0 | 3.2 / 8.9 | 1 | 4 | 14.7 | 0.5 |
| `get_query_result` | 0.40 / 1.1 | 2.4 / 9.3 | 1 | 1 | 0.3 | 0.3 |
| `search_entities` | 0.68 / 1.5 | 1.3 / 5.8 | 1 | 1 | 0.3 | 0.5 |
| `get_entity` | 0.31 / 1.0 | 1.9 / 5.6 | 1 | 5 | 0.3 | 0.4 |
| `get_related_entities` | 1.3 / 3.8 | 1.7 / 3.5 | 1 | 5 | 0.2 | 0.1 |
| `list_entity_types` | 1.1 / 3.8 | 3.0 / 7.2 | 1 | 1 | 0.1 | 0.4 |
| `decode_entity_guid` | 0.59 / 4.0 | 1.0 / 4.1 | 0 | 0 | 0.0 | 0.3 |
| `resolve_entity` | 0.51 / 3.6 | 0.40 / 1.8 | 1 | 4 | 0.3 | 0.4 |
| `get_golden_metrics` | 5.4 / 18.6 | 2.6 / 6.5 | 3 | 45 | 1.0 | 0.9 |
| `list_event_types` | 0.99 / 10.5 | 0.30 / 0.90 | 1 | 1 | 0.3 | 0.4 |
| `get_attributes` | 0.59 / 4.5 | 1.5 / 3.2 | 1 | 2 | 0.3 | 0.4 |
| `list_alert_policies` | 0.45 / 1.4 | 1.7 / 5.4 | 1 | 1 | 0.3 | 0.4 |
| `list_alert_conditions` | 0.46 / 3.9 | 0.90 / 3.4 | 1 | 1 | 0.5 | 0.5 |
| `list_recent_issues` | 0.65 / 1.2 | 0.70 / 1.9 | 1 | 9 | 0.7 | 0.5 |
| `search_incidents` | 1.4 / 2.7 | 1.1 / 4.5 | 1 | 5 | 0.4 | 0.5 |
| `list_error_groups` | 1.1 / 3.7 | 0.90 / 2.2 | 1 | 5 | 0.6 | 0.7 |
| `list_change_events` | 1.4 / 3.1 | 1.4 / 3.6 | 3 | 5 | 1.0 | 0.5 |
| `analyze_deployment_impact` | 1.6 / 3.2 | 1.9 / 3.9 | 1 | 13 | 0.4 | 1.5 |
| `list_top_transactions` | 0.60 / 1.1 | 2.3 / 4.6 | 1 | 6 | 14.7 | 0.3 |
| `analyze_transactions` | 0.96 / 1.4 | 4.9 / 8.5 | 2 | 12 | 14.7 | 1.4 |
| `list_recent_logs` | 1.8 / 2.9 | 0.80 / 1.7 | 1 | 6 | 0.3 | 0.4 |
| `analyze_entity_logs` | 0.58 / 2.2 | 1.5 / 3.1 | 3 | 10 | 14.7 | 0.2 |
| `analyze_threads` | 2.0 / 5.1 | 1.0 / 1.7 | 2 | 8 | 14.7 | 0.4 |
| `list_gc_metrics` | 0.75 / 1.6 | 1.7 / 4.4 | 1 | 6 | 14.7 | 0.3 |
| `analyze_kafka_metrics` | 0.68 / 2.9 | 1.5 / 4.2 | 3 | 6 | 14.7 | 0.4 |
| `list_synthetic_monitors` | 2.1 / 3.7 | 1.6 / 3.0 | 2 | 3 | 0.8 | 0.9 |
| `list_dashboards` | 0.48 / 1.6 | 1.5 / 2.5 | 1 | 1 | 0.3 | 0.4 |
| `get_dashboard` | 0.49 / 1.3 | 1.1 / 2.3 | 1 | 5 | 0.5 | 0.8 |
| `generate_alert_insights_report` | 3.9 / 7.6 | 3.1 / 7.4 | 10 | 32 | 2.6 | 3.4 |
| `generate_user_impact_report` | 2.9 / 5.0 | 2.1 / 3.6 | 2 | 18 | 0.9 | 0.8 |
| `trace_error` | 1.7 / 5.6 | 1.9 / 4.5 | 3 | 12 | 0.3 | 1.2 |
| `dependency_health` | 1.7 / 3.6 | 3.7 / 6.5 | 4 | 43 | 1.2 | 0.9 |
| `entity_health` | 3.9 / 7.3 | 8.7 / 16.6 | 7 | 29 | 2.8 | 3.0 |

Overhead is wall time minus the time inside the mock NerdGraph request, per call, so it is what relic-bridge adds
(validation, document building, parsing, shaping, MCP framing). On Workers it stands in for CPU time. NerdGraph requests are
also the external subrequests a Worker call spends. The sample count and the mean of 10 calls per sample average
out the coarse (whole millisecond) workerd clock, so Workers figures below 1 ms are approximations.

How to read it:

- **Requests vs declared cost.** The mock answers the happy path, so "NerdGraph requests" is the typical count. The
  declared cost is the worst case (async polls, name resolution; P6-20) that tool hiding and the budget use, which is why
  it is often higher. The worst case is asserted by `packages/core/test/tool-costs.test.ts`, not by this table.
- **Response size.** The mock replies with small recorded fixtures, so the response column understates real accounts. How
  CPU grows with payload size (10 KB to 500 KB) is in `pnpm bench:cpu`, and the Free preset's ceiling is above.
- **Workers overhead** is wall time inside a local workerd, which is not frozen like production, so it is a proxy for CPU
  time and runs higher than a real Worker's. Authentication, storage and the HTTP layer are not in these rows (see
  `pnpm bench:cpu`); they add to each request.
- **Latency you will see** is New Relic's time plus this overhead; the overhead is a few milliseconds at most for
  every tool, and the composites (`entity_health`, `dependency_health`, `generate_alert_insights_report`) cost more
  mainly through their request count.

## Costs

Prices from Cloudflare's pricing pages, **checked 2026-10-03** (they change; confirm before you rely on them):
[Workers](https://developers.cloudflare.com/workers/platform/pricing/) (page updated 2026-10-02),
[D1](https://developers.cloudflare.com/workers/platform/pricing/#d1), [KV](https://developers.cloudflare.com/workers/platform/pricing/#workers-kv).
There are no egress or bandwidth charges on either plan.

| Resource | Workers Free ($0) | Workers Paid ($5 per month per account) |
|---|---|---|
| Worker requests | 100,000 per day | 10 M per month included, then $0.30 per million |
| Worker CPU | 10 ms per request | 30 M CPU-ms per month included, then $0.02 per million CPU-ms |
| D1 rows read | 5 M per day | 25 B per month included, then $0.001 per million |
| D1 rows written | 100,000 per day | 50 M per month included, then $1.00 per million |
| D1 storage | 5 GB total | 5 GB included, then $0.75 per GB-month |
| KV (used by Phase 5 only) | 100,000 reads, 1,000 writes per day | 10 M reads, 1 M writes per month included, then $0.50 and $5.00 per million |
| Rate Limiting binding | no separate charge listed on the pricing page | same |
| Durable Objects (only with `RB_SHARED_LIMITER`, SQLite-backed) | 100,000 requests and 13,000 GB-s per day; 100,000 rows written, 5 M read, 5 GB stored | 1 M requests and 400,000 GB-s per month included, then $0.15 per million requests and $12.50 per million GB-s; rows as D1 |

Free-plan quotas reset at 00:00 UTC. Subrequests (the NerdGraph calls) are not billed.

### What a personal or small-team deployment costs (estimates)

The figures below are **estimates** from the P0-06 CPU measurements and the D1 call pattern, not measurements of a
billed account. Assumptions: 10 ms billed CPU and 3 requests (initialize, tools/list, tool call) per tool call; one D1
read batch per cache miss, and an audit row per call (each indexed row counts as more than one row written).

| Usage | Requests per month | Plan | Estimated cost |
|---|---|---|---|
| One person, 200 tool calls a day | about 18,000 | Free | $0 |
| Three devices, 1,000 tool calls a day | about 90,000 | Free (about 3,000 requests per day, 3% of the quota) | $0 |
| A team of 10, 20,000 tool calls a day | about 1.8 M | Paid | $5 (inside the included 10 M requests and 30 M CPU-ms: 1.8 M x 10 ms = 18 M) |
| Heavy automation, 500,000 tool calls a day | about 45 M | Paid | $5 + (45 M - 10 M) x $0.30/M + (450 M - 30 M) x $0.02/M = about $24 |

D1 stays far inside the allowances: audit rows are the main writes (several rows written per call once indexes count, so the
100,000 per day on Free is tens of thousands of calls, not hundreds of thousands), and the hourly purge bounds storage (90 days by default). Cron-trigger invocations are a handful per day.
The Free-plan D1 write quota is the first limit a busy Free deployment reaches, not requests: if audit writes fail, they
are logged and skipped and the calls still work (see "What happens at the limits"). To see your real usage, use the
Workers and D1 metrics in the dashboard (D1: Metrics, Row Metrics).

To cap a surprise bill on Paid, set a CPU limit (`limits.cpu_ms` in `wrangler.jsonc`, or Settings, CPU Limits) and keep
the rate limits on ([Cloudflare: custom limits](https://developers.cloudflare.com/workers/platform/pricing/)); T20 in the
[threat model](../THREAT_MODEL.md) covers abuse of a public instance.

### When to upgrade to Workers Paid

| Sign | Why it matters on Free | Paid |
|---|---|---|
| Queries return `RB_LIMIT_RESPONSE_TOO_LARGE` and narrowing is not an option | Free keeps responses at 512 KiB because parsing costs CPU against a 10 ms limit | 8 MiB ceiling |
| Calls fail with D1 "daily row write limit" errors | 100,000 rows written per day, mostly audit rows | 50 M per month included |
| More than about 100,000 requests a day (several people, automation, scripts) | Hard daily quota | 10 M per month included |
| Requests are killed with `exceededCpu` | 10 ms CPU limit per request | 30 s default |
| A tool needs more than 45 NerdGraph calls | 50 external subrequests per request | 1,000 (up to 10,000) |

Upgrading is an account change: set `RB_PLAN=paid` (`pnpm cf:setup --plan paid`) afterwards so the Worker uses the larger
limits. Without that, the Worker keeps behaving as on Free.

## Rate limiting on Workers

relic-bridge applies the same rate limits as on Node (per IP 600/min, failed authentications per IP 10 per 5 min, per
token 120/min, per grant 300/min unless the grant sets its own, per pass-through key 120/min), in two layers:

| Layer | What it does | Weakness |
|---|---|---|
| Per-isolate token bucket | Enforces the exact rule (including a grant's own `rateLimit`) with no I/O; provides the "peek" the auth-failure throttle needs. | Each isolate counts alone, so the effective limit is up to (isolates x limit). |
| Workers Rate Limiting binding `RATE_LIMITER` (`ratelimits` in `wrangler.jsonc`, default 600 per 60 s per key) | Shared backstop for the `ip:`, `token:`, `grant:` and `key:` buckets; a refusal answers `429` with `Retry-After: 60`. | One fixed limit and period (10 or 60 s) per binding; counted per Cloudflare location and eventually consistent, so it is permissive by design; cannot be peeked. |

- **Auth-failure throttle** is per isolate by default: the binding cannot report a count without consuming, so failed
  authentications are not shared across isolates or locations. An attacker spread over many isolates gets more guesses
  than on Node, but access tokens carry 256 bits of entropy and the admin token is refused at boot when predictable
  (P3-13). The [shared limiter](#shared-limiter-durable-object-optional) (`RB_SHARED_LIMITER=rules`) closes this gap;
  without it, a WAF rate-limiting rule on `/api/admin/*` is a cheap shared backstop ([deploy guide](cloudflare-deploy.md#harden-the-admin-api)). As on Node, the throttle
  refuses further *failures* only: a valid MCP or admin token is served from an address that sprayed bad ones (P3-13,
  Phase 2 review M6).
- **Client address** is `CF-Connecting-IP`, which Cloudflare sets and clients cannot override. Requests without it
  share one `unknown` bucket.
- **Fail open:** if the binding throws, the request is allowed and an error is logged; authentication still applies.
- To tighten the shared backstop, change `limit`/`period` of the `RATE_LIMITER` entry in `wrangler.jsonc`.
  `RB_RATE_LIMIT=off` turns all of it off (not recommended).
- Without the binding the Worker still starts (isolate buckets only) and logs a warning.

### Shared limiter (Durable Object, optional)

Some limits cannot be shared through the Rate Limiting binding (one fixed rule, no peek), and NerdGraph concurrency is
counted per isolate, so a key used by many clients at once can run `isolates x RB_CONCURRENCY` calls in parallel. New
Relic limits concurrent requests per user ([RESEARCH §2](../RESEARCH.md#2-nerdgraph-limits)) and answers `429` above
that. The `SharedLimiter` Durable Object (P7-10) keeps exact counters that every isolate shares. It is **off by default**.

| `RB_SHARED_LIMITER` | Counted by the object for the whole deployment | Object requests |
|---|---|---|
| `off` (default) | nothing (as before) | none |
| `rules` | failed authentications per address (`fail:`), sign-in (`signin:`) and OAuth (`oauth:`) requests per address, write tool calls per grant that can change something (`write:`) | one per counted request (a failed authentication, a sign-in or OAuth request, a charged write call) |
| `on` | the rules above, plus NerdGraph calls in flight per credential (`RB_CONCURRENCY`) | the above plus two per NerdGraph call (take and release a slot) |

Turn it on with `pnpm cf:setup --shared-limiter rules` (or `on`), or set the variable in the dashboard. The
`SHARED_LIMITER` binding and the class are declared in `wrangler.jsonc` (`durable_objects`, `exports`); Wrangler creates
the namespace on deploy, and an unused namespace costs nothing. A deployment whose `wrangler.local.jsonc` predates P7-10
lacks them: the Worker then logs `SHARED_LIMITER binding is missing` and keeps per-isolate limits.

How it behaves:

- **Concurrency:** one object per credential (named by the stored credential's id, or the fingerprint id for
  pass-through keys; never the key). A call waits in a first-come queue for up to 10 s; if no slot frees, the tool call
  fails with `RB_LIMIT_RATE` without calling New Relic. Each slot is a 60 s lease, so an isolate that crashes or is
  cancelled mid-call frees its slot on its own. The isolate's own semaphore still applies first.
- **Rules:** one object per key (for example one per client address), holding one token bucket in its storage, so it is
  not reset when the object is evicted; an alarm deletes the stored bucket once it has refilled. The `ip:`, `token:`,
  `grant:` and `key:` limits stay on the binding (asking the object on every request would add a round trip to each).
- **Failure policy:** if the object cannot be reached (an outage, or the Free plan's daily Durable Object limits),
  nothing is refused because of it: each rule falls back to the isolate bucket (a limit per isolate, the behaviour
  without the shared limiter, never "unlimited") and concurrency falls back to the isolate semaphore. A warning is
  logged (at most once a minute per isolate). The exception is the write limit (`write:`, P7-24): with the object bound,
  a write whose object cannot be reached is refused (429) instead of counted per isolate, because that would multiply
  the 20-per-hour cap by the number of isolates; reads are unaffected. Without `RB_SHARED_LIMITER` the write limit is per
  isolate and the Worker logs a startup warning when `RB_WRITE_TOOLS=on`; set `rules` (or `on`) when writes are enabled.
- **What the write limit counts (P7-35):** a write call that can change something: one that carries the person's
  answer (`inputResponses`) or `confirm: true` on a client that cannot be asked. The question-only first round of an
  elicitation and dry runs are not counted, so a confirmed write costs one of the 20 per hour; they still count
  against the per-token and per-grant limits, so form spam stays limited.
- **Latency, not CPU:** each object request is a round trip to the data center that hosts the object (the first
  caller's), a few milliseconds nearby and more from far away; it costs wall time, not CPU, so `pnpm bench:cpu` does
  not change. With `on`, every NerdGraph call pays two round trips.
- **Cost:** object requests count against the Durable Objects allowance, not Worker requests. On Free (100,000 a day)
  `rules` is negligible for normal use; `on` with tools of 1 to 4 NerdGraph calls uses 2 to 8 object requests per tool
  call, so about 12,000 to 50,000 tool calls a day exhaust it (then the fallback above applies until 00:00 UTC). On Paid
  the included 1 M a month covers about 125,000 to 500,000 tool calls; beyond it, $0.15 per million. Storage is tiny
  (one row per active address or grant, deleted once idle). Object calls count against the 1,000 Cloudflare-service
  subrequests per request on Free, not the 50 external ones that NerdGraph uses.

- **Quota counters (P7-12):** with `on`, the per-grant [usage quota](admin-guide.md#quotas-per-grant) counters live in
  one object per grant (named `quota:<grant id>`, holding at most the current day's and month's counters, an alarm drops
  periods that ended). Each New Relic call of a grant that has a quota costs one object request (two with both a day and a
  month cap) instead of a D1 write, and the cap is exact across isolates. An unreachable object falls back to the
  `grant_usage` table in D1 (still a cap; the two counts are separate until the object is back). Without `on` the counters
  are in D1: one write per call, atomic (a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE`).

Use `rules` when the auth-failure, sign-in or write limits must hold across isolates (a public instance); use `on` when
several people or agents share one New Relic key and you see `RB_NERDGRAPH_RATE_LIMITED`.

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
