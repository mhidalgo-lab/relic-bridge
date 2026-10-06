# Observability: self-monitoring with OpenTelemetry

relic-bridge can report how it behaves (tool latency, errors, refused requests) to New Relic's OTLP endpoint or to any
OpenTelemetry collector. It is **off by default** and nothing is sent until you turn it on.

Logs go to stderr as structured, redacted JSON; the [audit log](audit-log.md) records who did what. This page is only
about the optional OTLP export.

## Turn it on

| Variable | Default | Meaning |
| --- | --- | --- |
| `RB_OTEL` | `off` | `on` enables the export. |
| `RB_OTEL_ENDPOINT` | none (required when on) | OTLP/HTTP base URL. `/v1/traces` and `/v1/metrics` are appended. Must be `https` (plain `http` only for `localhost`), without credentials or a query string. |
| `RB_OTEL_HEADERS` | none | Request headers as `name=value,name2=value2` (values may be percent-encoded). **Secret**: put the New Relic license key here, e.g. `api-key=<license key>`. |
| `RB_OTEL_SAMPLE` | `1` | Share of tool calls exported as traces, `0` to `1` (or `off`). Metrics are always exported. |

New Relic example (US region; EU is `https://otlp.eu01.nr-data.net`):

```bash
# Node
RB_OTEL=on RB_OTEL_ENDPOINT=https://otlp.nr-data.net RB_OTEL_HEADERS="api-key=$NEW_RELIC_LICENSE_KEY" relic-bridge serve

# Cloudflare Worker: vars in wrangler.jsonc ("RB_OTEL": "on", "RB_OTEL_ENDPOINT": "...") and the headers as a secret
wrangler secret put RB_OTEL_HEADERS
```

Use the **license** (ingest) key for OTLP, not the User key relic-bridge uses to query NerdGraph. A wrong setting stops
the server at startup (Worker: 503); a collector that is down never affects a request.

## What is exported

Resource attributes: `service.name=relic-bridge`, `service.version`, `process.runtime.name` (`node` or `workers`).

| Signal | Name | Attributes |
| --- | --- | --- |
| Span (one per tool call, sampled) | `tools/call` | `tool`, `status` (`ok`/`error`), `error.code` (an `RB_*` code, errors only), `project` (slug, token connections), `mode` (`token`/`passthrough`) |
| Counter | `relic_bridge.tool.calls` | same as the span |
| Histogram (ms, delta) | `relic_bridge.tool.duration` | same as the span |
| Counter | `relic_bridge.requests.rejected` | `reason` (e.g. `rate_limit_ip`), `http.response.status_code` |

Every value is checked against a fixed pattern before export; anything unexpected (a made-up tool name from a client)
becomes `other`, so the number of distinct values stays small.

**Never exported:** NRQL text (not even masked), tool arguments, results from New Relic, account ids, user, grant, token
or OAuth client ids, emails, IP addresses, New Relic keys, device tokens, the master key, the endpoint and the headers.
See threat T30 in `docs/THREAT_MODEL.md`.

## Behaviour

- Exports run in the background (`ctx.waitUntil` on Workers), after the response is built. Each export has a 5 s timeout
  and at most 8 are in flight; extra ones are dropped.
- After a failed export (network error, non-2xx), exports pause for 30 s. One warning is logged with the error class only,
  never the endpoint or headers.
- Metrics use delta temporality, one data point per call; a few thousand calls an hour is far below any OTLP limit. On the
  Workers Free plan each exported call costs 1 to 2 subrequests, which are outside the NerdGraph call budget but count toward the 50
  subrequest limit of the request; lower `RB_OTEL_SAMPLE` if you are near it.
- Telemetry is not exported for the stdio server (`relic-bridge stdio`).

## Sending to a collector instead

Point `RB_OTEL_ENDPOINT` at an OpenTelemetry Collector's OTLP/HTTP receiver (default port 4318) and forward from there.
Use `http://localhost:4318` for a collector on the same host.
