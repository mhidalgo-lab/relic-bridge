# Charts (MCP Apps)

Clients that support the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps) (`io.modelcontextprotocol/ui`,
spec 2026-01-26) can show the result of `run_nrql` and `get_query_result` as an interactive chart inside the
conversation. Every other client gets exactly what it got before: the text table and `structuredContent`.

## What you see

| The query | The view |
|---|---|
| `TIMESERIES` with `FACET` | Line chart, one line per facet value (at most 10). A selector picks the metric when the query returns several. |
| `TIMESERIES` without `FACET` | Line chart, one line per numeric column. |
| `FACET` without `TIMESERIES` | Horizontal bars, first 25 facets in the order New Relic returned them. |
| Anything else (raw events, single values) | Table, first 100 rows and 12 columns. |
| Still running, failed, no rows | A one-line message. |

Click a legend entry to hide or show that line, use **Chart / Table** to switch to the rows, and hover a point or bar
for its value. Times are shown in the client's time zone and locale when the client shares them. The query text is
shown above the chart.

The view draws the rows the tool returned, after the usual output caps and summaries
([output formats](output-formats.md)): a summarized result (`detail: "auto"` on a large result) is drawn from its
downsampled rows, and the note under the chart says so. Ask for `detail: "full"` to draw more points.

## How it works

- The server offers one resource, `ui://relic-bridge/nrql-chart` (MIME type `text/html;profile=mcp-app`), and links
  `run_nrql` and `get_query_result` to it in `tools/list` with `_meta.ui.resourceUri` (plus the older
  `_meta["ui/resourceUri"]` spelling). Both appear only when the connection may use `run_nrql`, like the other
  [resources](../reference/resources.md).
- When a client that supports MCP Apps calls one of those tools, it loads the page into a sandboxed iframe and hands it
  the tool result over `postMessage`. The page draws an SVG chart from `structuredContent`.
- The page is one self-contained HTML document of about 25 KB bundled with the server: no external script, style,
  font or image, no network access (its resource declares no CSP domains, so the client's default policy applies:
  `connect-src 'none'`), and a `Content-Security-Policy` of its own that says the same.

## Safety

Everything in a chart (facet values, column names, cell values, the NRQL) is New Relic data, so it is untrusted:

- The page builds its DOM with `textContent` and SVG elements only. No data is ever parsed as HTML, used as an
  attribute name, a URL, a style or code. Hostile labels such as `<img onerror=…>` are shown as text (tested).
- The page accepts messages only from its parent window and only as JSON-RPC, and sends nothing but protocol messages
  (`ui/initialize`, `ui/notifications/initialized`, its size). No row leaves the iframe.
- It draws only the result the client already received from the tool; it makes no request of its own, and the tools
  are marked `visibility: ["model"]`, so the page cannot ask the client to call them.
- The host's theme variables are applied only for a fixed list of names (colours and fonts), and values that could load
  anything (`url(…)`) are ignored.

## Clients

| Client | Charts |
|---|---|
| Claude (web, Desktop) | Expected: these clients implement MCP Apps. **Not verified** with relic-bridge yet. |
| Claude Code, Cursor, other text clients | No chart: the text table, unchanged. |
| ChatGPT, VS Code | Implement MCP Apps per their vendors; not verified. |

See [client compatibility](../reference/client-compatibility.md). If a client shows a broken or empty view, the text
answer in the conversation is still complete; please report it with the client name and version.

## Turning it off

There is no switch yet: clients without MCP Apps ignore the view. An operator switch and capability-based advertising
are planned (P7-16). A connection without `run_nrql` never sees the view.
