# Observability: self-monitoring with OpenTelemetry

relic-bridge can report how it behaves (tool latency, errors, refused requests) to New Relic's OTLP endpoint or to any
OpenTelemetry collector. It is **off by default** and nothing is sent until you turn it on.

Logs go to stderr as structured, redacted JSON; the [audit log](audit-log.md) records who did what. This page is only
about the optional OTLP export.

## Turn it on

| Variable | Default | Meaning |
| --- | --- | --- |
| `RB_OTEL` | `off` | `on` enables the export. |
| `RB_OTEL_ENDPOINT` | none (required when on) | OTLP/HTTP base URL. `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended. Must be `https` (plain `http` only for `localhost`), without credentials or a query string. |
| `RB_OTEL_HEADERS` | none | Request headers as `name=value,name2=value2` (values may be percent-encoded). **Secret**: put the New Relic license key here, e.g. `api-key=<license key>`. |
| `RB_OTEL_SAMPLE` | `1` | Share of tool calls exported as traces, `0` to `1` (or `off`). Metrics are always exported. |
| `RB_OTEL_TRACEPARENT` | `off` | `on`: a span joins the trace of an incoming W3C `traceparent` header (HTTP only). See [Trace context](#trace-context). |

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
| Span (one per tool call, sampled) | `tools/call` | `tool`, `status` (`ok`/`error`), `error.code` (an `RB_*` code, errors only), `project` (slug, token connections), `mode` (`token`/`passthrough`/`stdio`), `nerdgraph.calls`, `nerdgraph.response_bytes` |
| Counter | `relic_bridge.tool.calls` | same as the span |
| Histogram (ms, delta) | `relic_bridge.tool.duration` | same as the span |
| Counter | `relic_bridge.nerdgraph.calls` | New Relic API calls the tool call made (retries included; query-cache hits are not calls); attributes as the span, without the usage numbers |
| Counter (`By`) | `relic_bridge.nerdgraph.response_bytes` | bytes read from New Relic for the tool call; same attributes |
| Log record (`info` and above) | the log message | `tool`, `code`, `errorCode`, `status`, `error` (error class), `path`, `reason`, `ms`, `removed`, and on the `http request` access-log line `method`, `route` (see below) |
| Counter | `relic_bridge.requests.rejected` | `reason` (e.g. `rate_limit_ip`), `http.response.status_code` |

Every value is checked against a fixed pattern before export; anything unexpected (a made-up tool name from a client)
becomes `other`, so the number of distinct values stays small.

### Logs

The same structured log that goes to stderr is also exported as OTLP logs, after the same redaction, and then through its
own allowlist: severity, the message (only when it reads like a fixed phrase: letters, digits and basic punctuation, no
NRQL words, no long opaque strings; otherwise `other`) and the fields listed above, each pattern-checked. Any other field
a log line carries (NRQL, ids, emails, request text) is dropped. `debug` lines and the exporter's own warnings are not
exported. Records wait in a buffer of 200 (oldest dropped) and are sent with the next tool call or rejected request
(Workers, inside `waitUntil`), every 5 s (Node) and at shutdown. A quiet Worker therefore delays its logs until the next
request; Workers Logs remain the complete record.

**Attribute names.** The exporter writes the log fields as OTLP attributes named `log.<field>` (`log.tool`, `log.ms`,
...). In New Relic they appear as `tool`, `ms`, `code`, ... without the prefix (observed on a live 0.9.0 export, 2026-10-14;
the cause, New Relic's OTLP log mapping, is not documented anywhere we could find). Query the short names in New Relic,
for example `SELECT count(*) FROM Log WHERE service.name = 'relic-bridge' FACET message`. Another collector shows the
`log.`-prefixed names. Records also carry `service.name`, `service.version`, `process.runtime.name` and `severity.text`.

**Access log.** Every HTTP request is one `http request` record (`debug` for `/health`, so not exported) with:
`status` (the HTTP status code, an integer: count 4xx/5xx with `WHERE status >= 400`), `method` (`GET`, `POST`,
`DELETE`, `OPTIONS`, `HEAD`, anything else `other`), `route` (the route **pattern** the app matched, such as
`/p/:slug/mcp`; never the request path, query string or an id; a request no route matched is `other`) and `ms`. The
`status` field of tool-call records is a short word instead (`ok`, `error`), so filter on `message = 'http request'`
when you chart HTTP statuses.

**Deadlines.** `mcp request timed out` (WARN) means a request did not finish within the request timeout
(`requestTimeoutMs`, 180 s by default): a tool call that hung or a body that never arrived. An open-ended stream (a
standalone `GET` stream or `subscriptions/listen`) that simply reaches the same deadline is normal and logs
`mcp stream closed at deadline` at `info`; the client reconnects.

### Trace context

With `RB_OTEL_TRACEPARENT=on`, a valid incoming `traceparent` header (version `00`, lowercase hex, non-zero ids; anything
else is ignored) makes the span use that trace id and parent span id, so a call shows up inside the client's trace. It
is off by default because the ids are chosen by the caller: they are used for correlation only. They never affect
authorization, rate limits, sampling of anything else, the audit log or what is returned, `tracestate` and baggage are
ignored, and the header is **not** forwarded to New Relic's API (no benefit, and it would hand the caller's trace ids to
a third party outside your own collector). The stdio server has no incoming header.

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
- `relic-bridge stdio` supports the same variables (except `RB_OTEL_TRACEPARENT`). The exporter uses only `fetch` and the
  stderr logger; it never writes to stdout, which is the MCP channel. Exports in flight are awaited (briefly) at shutdown.

## Sending to a collector instead

Point `RB_OTEL_ENDPOINT` at an OpenTelemetry Collector's OTLP/HTTP receiver (default port 4318) and forward from there.
Use `http://localhost:4318` for a collector on the same host.
