# P0-06: deploy and measure on a real free-plan account

Run these on **your** Cloudflare account (free plan). Everything uses synthetic data. Delete the Workers and the
D1 database afterwards (last step). Run from `spikes/workers-limits/`, with `pnpm install` already done.

## 1. Create resources and deploy

```sh
export PATH=$HOME/.local/bin:$PATH
pnpm exec wrangler whoami                                   # confirm the account; must be on the Free plan
pnpm exec wrangler d1 create spike-workers-limits           # copy the printed database_id into wrangler.jsonc
pnpm exec wrangler deploy -c mock.wrangler.jsonc            # mock NerdGraph first (service binding target)
pnpm exec wrangler deploy -c wrangler.jsonc
head -c 32 /dev/urandom | base64 | pnpm exec wrangler secret put MASTER_KEY -c wrangler.jsonc
printf 1 | pnpm exec wrangler secret put ALLOW_SEED -c wrangler.jsonc   # temporary, removed in step 3
```

## 2. Seed and generate load

```sh
URL=https://spike-workers-limits.<your-subdomain>.workers.dev
TOKEN=$(curl -s -XPOST "$URL/seed" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).token))')
pnpm exec wrangler secret delete ALLOW_SEED -c wrangler.jsonc          # close the seed route again

# Optional: watch for CPU-limit kills live (outcome "exceededCpu", HTTP 1102 to the client)
pnpm exec wrangler tail spike-workers-limits --format json | grep -o '"outcome":"[a-zA-Z]*"' &

node src/load.ts "$URL" "$TOKEN" 50     # 50 calls per payload size: 10k, 100k, 1m, 5m
```

Also run a **cold** sample: wait ≥ 15 minutes (or redeploy) and send one call per size, five times. The first
call in a fresh isolate pays lazy compilation of the SDK request path (see RESULTS.md).

## 3. Read CPU time

Per-request CPU time isn't in the documented `wrangler tail` JSON. Use either:

- **Dashboard**: Workers & Pages → `spike-workers-limits` → Metrics → *CPU time* (median / P99).
- **GraphQL Analytics API** (documented in "Querying Workers Metrics with GraphQL"): `cpuTimeP50` / `cpuTimeP99`
  quantiles and `sum.subrequests`. Needs an API token with *Account Analytics: Read*.

```sh
cat > /tmp/q.json <<'Q'
{"query":"query($a: string, $s: string, $from: string, $to: string){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:50,filter:{scriptName:$s,datetime_geq:$from,datetime_leq:$to}){sum{requests subrequests errors} quantiles{cpuTimeP50 cpuTimeP99} dimensions{status}}}}}",
 "variables":{"a":"<ACCOUNT_ID>","s":"spike-workers-limits","from":"<ISO start>","to":"<ISO end>"}}
Q
curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer <API_TOKEN>" \
  -H 'Content-Type: application/json' --data @/tmp/q.json
```

`cpuTime*` values are reported in **microseconds** (verify against the response; the dashboard shows ms).
Run one load batch per payload size in separate time windows (or deploy four copies) so the quantiles can be
attributed to a size.

- **Workers Logs** (enabled in `wrangler.jsonc` via `observability`): the invocation logs in the dashboard query
  builder show the outcome per request. Check whether a CPU-time field appears and note its exact name in RESULTS.md.

## 4. Record and clean up

Fill in the "Production measurements" table in `RESULTS.md`, then delete everything:

```sh
pnpm exec wrangler delete spike-workers-limits
pnpm exec wrangler delete spike-mock-nerdgraph
pnpm exec wrangler d1 delete spike-workers-limits
```
