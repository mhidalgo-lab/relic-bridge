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

Resource attributes: `service.name=relic-bridge`, `service.version`, `process.runtime.name` (`node` or `workers`),
`telemetry.sdk.name=relic-bridge` (a small hand-written exporter, not the OpenTelemetry SDK), `telemetry.sdk.language`
(`nodejs`; `webjs` on Workers, the closest well-known value for a non-Node JavaScript runtime) and
`telemetry.sdk.version`, plus `service.instance.id`: a random 128-bit hex id generated when the process (or Worker
isolate) starts, never derived from host, user or request data. New Relic uses `service.instance.id` to facet instances
and `telemetry.sdk.language` for language-aware pages.

| Signal | Name | Attributes |
| --- | --- | --- |
| Span (one per tool call, sampled) | `tools/call <tool>` (`tools/call other` for an unknown name) | `tool`, `status` (`ok`/`error`), `error.code` (an `RB_*` code, errors only), `fault` (`caller`/`server`, errors only, see [Caller and server errors](#caller-and-server-errors)), `project` (slug, token connections), `mode` (`token`/`passthrough`/`stdio`), `nerdgraph.calls`, `nerdgraph.response_bytes` |
| Histogram (ms, delta) | `rpc.server.duration` | `rpc.system=jsonrpc`, `rpc.service=mcp`, `rpc.method` (the tool name, else `other`), and on **server** errors only `error.type` (the `RB_*` code) and `rpc.grpc.status_code` (an integer, see below). New Relic builds the service's throughput, response time and error rate from this metric |
| Counter | `relic_bridge.tool.calls` | same as the span |
| Histogram (ms, delta) | `relic_bridge.tool.duration` | same as the span |
| Counter | `relic_bridge.nerdgraph.calls` | New Relic API calls the tool call made (retries included; query-cache hits are not calls); attributes as the span, without the usage numbers |
| Counter (`By`) | `relic_bridge.nerdgraph.response_bytes` | bytes read from New Relic for the tool call; same attributes |
| Log record (`info` and above) | the log message | `tool`, `code`, `errorCode`, `status`, `error` (error class), `path`, `reason`, `ms`, `removed`, and on the `http request` access-log line `method`, `route` (see below) |
| Counter | `relic_bridge.requests.rejected` | `reason` (e.g. `rate_limit_ip`), `http.response.status_code` |

Spans also carry the OpenTelemetry MCP attributes `mcp.method.name=tools/call`, `gen_ai.operation.name=execute_tool`,
`gen_ai.tool.name`, the `rpc.system`, `rpc.service`, `rpc.method` and `error.type` (server errors only) described
above, and `network.transport` (`tcp` for HTTP, `pipe` for stdio). Span status is `OK` for a successful call, `ERROR`
(with the `RB_*` code as the description) for a server error and **Unset** for a caller error. Tool arguments, results
and the MCP session id are never attributes.

Every value is checked against a fixed pattern before export; anything unexpected (a made-up tool name from a client)
becomes `other`, so the number of distinct values stays small.

### Caller and server errors

A failed tool call is either the **caller's** (the request can't be served as asked: they can fix it by changing the
request) or the **server's** (relic-bridge, its New Relic credential or New Relic failed). Following the OpenTelemetry
conventions for a server operation, only server errors are errors: they set span status `ERROR`, `error.type` and count
in the New Relic service's Error rate and Errors Inbox. A caller error is the equivalent of an HTTP 4xx (or the MCP
convention's "invalid params", which a server SHOULD NOT treat as an error): span status stays Unset, there is no
`error.type`, and it is still counted by `status = 'error'`, `error.code` and `fault = 'caller'` on the spans and the
`relic_bridge.*` metrics.

| `error.code` | `fault` | `rpc.grpc.status_code` | Why |
| --- | --- | --- | --- |
| `RB_INPUT_INVALID` | caller | | Invalid arguments, or New Relic rejected the request as invalid (an NRQL syntax error). |
| `RB_AUTH_UNAUTHORIZED`, `RB_AUTH_FORBIDDEN` | caller | | The connection is not allowed this account or resource. |
| `RB_LIMIT_QUERY`, `RB_LIMIT_RESPONSE_TOO_LARGE` | caller | | The query exceeds the connection's limits (window, LIMIT, size): narrow it. |
| `RB_LIMIT_RATE`, `RB_LIMIT_QUOTA` | caller | | The caller's rate limit or quota. |
| `RB_QUERY_NOT_FOUND` | caller | | The `query_id` is unknown or expired. |
| `RB_TOOL_DISABLED` | caller | | The connection is not granted the tool (or arbitrary NRQL). |
| `RB_BUDGET_EXHAUSTED` | caller | | The request needs more NerdGraph calls than one tool call may make: like a query limit, the hint is to narrow the request (fewer entities, shorter window). |
| `RB_AUTH_INVALID_KEY`, `RB_AUTH_WRONG_REGION` | server (token, stdio); caller (pass-through) | 13 (INTERNAL) | New Relic refused the key. On a token connection or stdio it is the operator's stored key, which no caller can fix; on pass-through it is the caller's own key. |
| `RB_NERDGRAPH_UNAVAILABLE` | server | 14 (UNAVAILABLE) | New Relic could not be reached or answered 5xx. |
| `RB_NERDGRAPH_RATE_LIMITED` | server | 14 (UNAVAILABLE) | New Relic throttled the key (gRPC's HTTP mapping also turns 429 into UNAVAILABLE). |
| `RB_NERDGRAPH_TIMEOUT` | server | 4 (DEADLINE_EXCEEDED) | New Relic, or the query, did not answer in time. |
| `RB_NERDGRAPH_ERROR` | server | 2 (UNKNOWN) | New Relic answered something unexpected. |
| `RB_INTERNAL`, any other value (`other`, a future code) | server | 13 (INTERNAL), 2 (UNKNOWN) | A relic-bridge failure; an unexplained code counts rather than hides. |

**Why `rpc.grpc.status_code`.** New Relic counts a `rpc.server.duration` data point in `apm.service.error.count`
(the service's Error rate) only when `rpc.grpc.status_code` is 2, 4, 12, 13, 14 or 15; `error.type` alone is ignored on
this metric. relic-bridge speaks JSON-RPC, not gRPC, so setting a gRPC status code is a deliberate deviation from the
conventions: it is set on server errors only, on that metric only (not on spans), from the fixed table above. If you
send to another backend, ignore it and use `error.type`.

Count both kinds in New Relic (`fault` exists from the version with this change on):

```sql
SELECT count(*) FROM Span WHERE service.name = 'relic-bridge' AND status = 'error' FACET fault, error.code SINCE 1 day ago
```

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

**MCP method.** Records of MCP requests (`http request` on the MCP routes and the deadline lines) carry `mcpMethod`,
the JSON-RPC method from a fixed list (`initialize`, `ping`, `tools/list`, `tools/call`, `resources/*`, `prompts/*`,
`tasks/*`, `subscriptions/listen`, `notifications/*`, `logging/setLevel`, `completion/complete`; anything else is
`other`), and `mcpName` only for `tools/call` (the tool name, same pattern check as `tool`). Resource URIs and prompt
names are never exported. To see what the timeouts are:
`SELECT count(*) FROM Log WHERE service.name = 'relic-bridge' AND message = 'mcp request timed out' FACET mcpMethod SINCE 1 day ago`.

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

## The service entity in New Relic (golden metrics, Errors Inbox)

New Relic creates an external-service entity (EXT/SERVICE) from `service.name`. Its golden metrics (throughput,
response time, error rate) are computed from `apm.service.transaction.duration`, which New Relic synthesizes from the
OpenTelemetry **metric** `rpc.server.duration` (or `http.server.request.duration`), not from spans; spans only feed
the transaction overview and Errors Inbox. relic-bridge exports `rpc.server.duration` for this reason, so the entity's
transactions are named `WebTransaction/server/jsonrpc/mcp.<tool>`. Spans are named `tools/call <tool>`, so Errors Inbox
groups are distinct per tool. Only server errors open Errors Inbox groups and count in the Error rate (see
[Caller and server errors](#caller-and-server-errors)).

Check after deploying (replace `relic-bridge` if you changed the service name; filter on `service.name`: on the
synthesized metric a `WHERE entity.name = ...` filter returned nothing in our tests although the attribute is there):

```sql
SELECT count(apm.service.transaction.duration), rate(count(apm.service.transaction.duration), 1 minute),
  average(convert(apm.service.transaction.duration, unit OR 's', 'ms')), sum(apm.service.error.count)
FROM Metric WHERE service.name = 'relic-bridge' SINCE 1 hour ago FACET transactionName
```

The entity's Summary page then shows throughput, response time and (after a server error) the Error rate. Versions
before this change exported `error.type` without `rpc.grpc.status_code`, so their Error rate stays 0, and every caller
error opened an Errors Inbox group; resolve those groups once you upgrade.
