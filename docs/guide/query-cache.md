# Query cache

relic-bridge keeps NRQL results for a short time, so a question asked twice (an agent re-checking a number, `detail:
"full"` after a summary, two report sections running the same query) is answered without another New Relic call.
Every tool that runs NRQL uses it; nothing else is cached here.

## What is reused, and for how long

| The query's time window | Reused for | Why |
|---|---|---|
| Moves with the clock: `SINCE 30 minutes ago`, `SINCE yesterday`, no `UNTIL`, any subquery | `RB_QUERY_CACHE_TTL` seconds (default 30, at most 300) | The answer changes as time passes; a result is never older than this. |
| Fixed: `SINCE <epoch or date> UNTIL <epoch or date>`, ended at least 15 minutes ago | 10 minutes | The data has settled; late events stop arriving after a few minutes. |
| Fixed but ended less than 15 minutes ago | as a moving window | Late data may still arrive. |

Only finished results are kept. A query still running (`pending`), an error and `get_query_result` polls never are.
Results over 256 KiB are not stored.

Every NRQL result says what the cache did in `_meta["relic-bridge/result"].cache`:
`{ "status": "hit" | "miss" | "bypass" | "off", "store", "ageSeconds", "ttlSeconds", "stored" }`. A hit also adds
one line before the rows: `Served from the query cache, 12 s old.`

`note` appears on a miss when the shared per-colo tier (Worker, `RB_QUERY_CACHE=on`) cannot serve later requests. This
is the case on `*.workers.dev` hostnames, where the Workers Cache API accepts a write and returns nothing. The result is
then kept in the memory of that isolate only (`stored` stays `true`, and a repeat that reaches the same isolate is a
`hit` from `memory`), and a repeat served by another isolate runs the query again. Use a custom domain or a route on a
Cloudflare zone for the shared cache. The Worker checks once per isolate (and every 5 minutes while it fails), at the
cost of one extra Cache API call.

## Fresh answers

- `run_nrql` takes `cache: "bypass"`: the query runs again and the fresh result replaces the stored one.
- `RB_QUERY_CACHE=off` turns the cache off (stdio, `serve` and the Worker). `RB_QUERY_CACHE_TTL=0` caches only
  settled fixed windows.

## Who can see a cached result

A cached result is only ever served to a call that would have received the same answer from New Relic. The entry id
is an HMAC over:

- the **connection scope**: one stdio process, one grant of one project (`serve` and the Worker), or pass-through;
- the **credential**: its id, region and a hash of the New Relic key itself (a rotated key or another pass-through key
  never hits an older entry);
- the **accounts** queried, the connection's **query limits** (LIMIT cap, window, event-type allow/deny lists, raw
  NRQL, response cap) and whether stats were asked for;
- the **NRQL actually sent** (after query limits; only whitespace between tokens is ignored) and the time bucket.

The account check and the query limits run **before** the cache is consulted, so a query the connection may not run is
refused even if another connection cached it. No key, token or NRQL text appears in an entry id.

## Quotas

A cache hit makes no New Relic call, so it is not counted against a grant's [quota](admin-guide.md#quotas-per-grant),
and a grant at its hard cap is still served what the cache already holds for it (30 s or 10 min at most).

## Where results live

| Runtime | Store | Notes |
|---|---|---|
| stdio, `serve` | process memory, at most 500 entries / 16 MiB (least recently used goes first) | Gone when the process stops. |
| Worker, `RB_QUERY_CACHE=memory` (Free default) | isolate memory, same bounds | Each isolate has its own. |
| Worker, `RB_QUERY_CACHE=on` (Paid default) | isolate memory, then the data center's Cache API | Shared by the isolates of one Cloudflare location. Bodies are encrypted (AES-GCM, key derived from the master key, bound to the entry id) under an unreachable `https://query-cache.relic-bridge.invalid/…` URL with `Cache-Control: max-age` only; the expiry is re-checked from inside the ciphertext. Each Cache API lookup or write counts as one subrequest of the request budget, and is skipped once half of that budget is spent. A rotated master key starts an empty cache. Cloudflare documents working Cache API operations for Workers on custom domains; elsewhere (e.g. `workers.dev`, dashboard previews) expect misses only. |

A store that fails (Cache API unavailable) is a miss, never an error.
