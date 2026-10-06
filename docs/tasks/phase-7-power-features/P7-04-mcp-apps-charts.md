---
id: P7-04
title: "Interactive charts via MCP Apps extension"
phase: 7
status: in-progress
priority: medium
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-04 — Interactive charts via MCP Apps extension

## Scope
- Implement the MCP Apps extension (`io.modelcontextprotocol/ui`, stable spec `2026-01-26`) for NRQL results:
  - One UI resource `ui://relic-bridge/nrql-chart` (MIME `text/html;profile=mcp-app`), offered under the same rule as
    the other resources: only when `run_nrql` is in the connection's allowed list. Resource content carries
    `_meta.ui.csp` with no extra domains (no network, no remote scripts/styles/images/frames) and `prefersBorder`.
  - `run_nrql` and `get_query_result` declare `_meta.ui.resourceUri` (and the deprecated flat `ui/resourceUri` key
    for older hosts) only when the resource is offered on that connection; `visibility: ["model"]` so the view can't
    call tools through the host.
  - The view is one self-contained HTML page (inline style and script, no dependency, no external URL) that speaks
    the spec's JSON-RPC over `postMessage` without the SDK: `ui/initialize`, `ui/notifications/initialized`,
    `ui/notifications/tool-result`, `ui/notifications/host-context-changed`, `ui/notifications/size-changed`,
    `ui/resource-teardown`, `ping`. It renders the tool's own `structuredContent` (no fetches of its own):
    - timeseries → SVG line chart (one series per facet or per numeric column; at most 10 series);
    - faceted, not timeseries → horizontal bar chart (top 25);
    - anything else → table (first 100 rows, 12 columns);
    - pending / error / empty / unrecognised → a short message.
    Interactive: metric selector when several numeric columns, legend toggles series, chart/table switch, native
    tooltips (`<title>`).
  - Source kept as a plain asset (`packages/core/assets/chart-app.{html,js,css}`) and embedded at build time into
    `packages/core/src/apps/chart-app.generated.ts` by `scripts/gen-app-assets.ts` (`--check` in `pnpm lint`), like the
    admin UI assets. The asset directory is covered by `scripts/check-ui-escaping.ts`.
- Text output, `structuredContent` and `_meta` of tool results do not change: clients without MCP Apps see exactly
  what they saw before (graceful fallback); they only see one more resource and an ignored `_meta.ui` on two tools.

## Acceptance criteria
- [ ] Task refined (this file) before implementation.
- [ ] `resources/list` shows the UI resource only with `run_nrql` allowed; `resources/read` returns the HTML with the
      MCP App MIME type and the CSP metadata; `tools/list` carries `_meta.ui` on the two NRQL tools only then.
- [ ] The view renders line, bar and table views from `structuredContent` (jsdom tests driving the real HTML through
      the postMessage protocol), ignores messages not from its parent or not JSON-RPC, and never fetches anything.
- [ ] Injection tests: hostile column names, facet values, cell values and NRQL (`<img onerror>`, `<script>`,
      `javascript:` text, SVG/HTML markup) appear only as text; no element or attribute is created from data; static
      check: no `innerHTML`-style sink, no external URL, no `<script src>` in the page.
- [ ] Fallback: tool `content` / `structuredContent` / `_meta` unchanged by this task (existing output tests pass,
      plus a test that the call result carries no UI fields).
- [ ] Negative authorization test (P2-12 suite): a grant without `run_nrql` sees no UI resource and can't read it.
- [ ] Worker bundle growth noted (one ~15 KB string); `pnpm bench:cpu` unchanged.
- [ ] Renders in at least one Claude surface; graceful fallback elsewhere. *(Needs the owner: no client in the
      autonomous run; logged in pending decisions.)*

## Security notes
UI must escape all telemetry content (T6/T13): DOM building with `textContent` / `createElementNS` and numeric
attributes only. The view trusts only `window.parent` messages, sends nothing but protocol messages (no data leaves the
iframe), declares no network domains (host default CSP: `connect-src 'none'`), and its data is the already-authorized
tool result. Host CSS variables are applied only for a fixed list of names.

## Docs to update
- Charts guide (`docs/guide/charts.md`), `docs/reference/resources.md` (generated), `docs/reference/client-compatibility.md`,
  `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/RESEARCH.md`.

## Out of scope
- Capability-gated registration (only advertise `_meta.ui` when the client declares the extension) and an operator
  switch to turn the UI off: P7-16.
- Charts for other tools (golden metrics, `analyze_*`), app-initiated tool calls, fullscreen/pip modes.
