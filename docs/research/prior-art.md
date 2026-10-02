# Prior art review: community New Relic MCP servers (P0-10)

Date: 2026-10-01. Method: shallow clone of each repo (`gh`), read of README, entry point, NRQL/GraphQL construction, auth/config
code, plus `gh issue/pr list`. Source reading was targeted, not a full audit; anything not checked is marked "not verified".
Ideas only, no code copied. Licenses are listed so we know what we may reuse in spirit; we reuse none of the text.

## 1. Comparison table

| Project | Lang / runtime | Transport | Auth model | Multi-account | Tools | NRQL / GraphQL construction | Write tools | License | Stars / last push |
|---|---|---|---|---|---|---|---|---|---|
| cloudbring/newrelic-mcp | TS, Node (official MCP SDK, zod) | stdio; Smithery `shttp` build | one User key in env | per-call `target_account_id` over a default | ~18 | **String interpolation** into GraphQL (NRQL only escapes `"`) | yes (ack incident, create monitor/deployment, delete deployment), ungated | MIT | 14 / 2026-07-11 |
| alanhoff/newrelic-mcp | JS, Node 22 (MCP SDK, zod) | stdio | one key + `NERDGRAPH_URL` in env | none (run one server per env) | 14 | GraphQL **variables** for NRQL; some NRQL built by interpolation (logs/alerts by GUID) | `run-raw-nerdgraph-query` accepts mutations, ungated | ISC (package.json only, no LICENSE file) | 4 / 2026-07-08 |
| ulucaydin/mcp-server-newrelic | Python, FastMCP | FastMCP default (HTTP/SSE on :8000 per README; stdio with `fastmcp run` not verified) | one key in env, import fails without it | per-call `target_account_id` | ~10 + resource + prompt | NRQL via variables; entity-search filter via f-string with `'` escaping only | ack incident, create synthetic monitor | none in repo (README badge says MIT) | 3 / 2025-08-13 (stale) |
| thrashy/mcp-newrelic | Python 3.11, official MCP SDK | stdio (Docker `run -i`) | one key: CLI > JSON file > env | pinned to configured account unless `ALLOW_ACCOUNT_OVERRIDE` | ~55 | Variables for NRQL; `escape_nrql_string` (`\`, `'`, backtick) for entitySearch filters | **many**, gated: read-only default, `ENABLE_WRITES`, `ENABLE_DESTRUCTIVE`, allow/deny lists | MIT | 9 / 2026-09-28 (last commit 2026-08-18) |
| piekstra/newrelic-mcp-server | Python, FastMCP | stdio | env or macOS Keychain | none (single account, optional id param) | ~30 | NRQL via variables; REST v2 paths interpolate ids unvalidated | create_deployment, log parsing rule CRUD, **manage_credentials** (store/delete key), dashboard widgets | MIT | 6 / 2026-07-15 |
| adjohn/newrelic-mcp-app | TS, Node, Express + React "MCP app" views | **Streamable HTTP** (:3001, `/mcp`) and stdio | per-session `x-nr-*` headers, else env | one key per session via headers; account id param | 17 | Variables for the base NRQL tool; workflow tools build NRQL by interpolation (`'` escaped, **time range unescaped**) | read-only (all 17 tools) | Apache-2.0 | 1 / 2026-04-08 |
| xelber/newrelic-mcp | TS, Node (axios, zod) | stdio | one key in env, US endpoint hard-coded | none | 6 | Interpolation into GraphQL (only `"` escaped); `'` and `%` escaped for filters; time range unescaped | none (logs/APM read only) | MIT (package.json only) | 1 / 2025-11-05 (stale) |

Open issues at review time: cloudbring 0 open (EU region request #20 closed by v2.1.0); thrashy 1 open (#31 `update_workflow`
issues_filter wrapped incorrectly); xelber 4 open "enhancement" issues (alert tools, entity discovery, error analytics, multi-account);
alanhoff, ulucaydin, piekstra, adjohn: none. Signal: tiny communities, little user feedback; the bugs that exist are NerdGraph
input-shape bugs and missing region/multi-account support.

## 2. Per-project notes

### cloudbring/newrelic-mcp
- Most "mainstream" of the set (Smithery listing, CI on Node 20/22/24, MCP Registry prep PR open).
- Tools: `run_nrql_query`, `list_apm_applications`, `get_account_details`, entity search/details, alert policies, open incidents,
  `acknowledge_incident`, synthetics list/create, `run_nerdgraph_query`, plus REST v2 tools (deployments create/list/delete, APM apps,
  metric names/data for host, application hosts).
- Ideas: `target_account_id` argument convention with env default; discovering tools without credentials (lazy auth so registries
  can introspect); region added late after a user hit "not authorized for account region" (issue #20), which shows the error is
  confusing when the region is wrong, so surface a region hint in our error mapping.
- Descriptions are one-liners ("Execute NRQL queries against New Relic data to analyze metrics and events"), no guidance on SINCE/LIMIT.
- Output: raw `JSON.stringify(result, null, 2)` as one text block; errors thrown as generic InternalError with the upstream message.
- Security: see Section 4 (S1, S2, S3, S5).

### alanhoff/newrelic-mcp
- Tools: `nrql`, `introspection`, `searchEntity`, `getEntityByName/Guid`, `getDashboardByName/Guid`, `getGoldenMetricsByGuid`, `getLogs`,
  `getAlerts`, `getServiceLevelsForGuid`, `getRelatinshipsForGuid` (sic), `run-raw-nerdgraph-query`, `generate-nerdgraph-query`.
- Good ideas: (a) **async NRQL with polling** (`async: true` plus `nrqlQueryProgress`, honoring `retryAfter`, 10 min cap) to dodge
  HTTP timeouts on slow queries; (b) entity tools **scope every result to the configured account** by construction; (c) `tagMapper`
  flattens `{key, values[]}` tag arrays into `key:value` strings to cut tokens; (d) vendored `schema.graphql` plus local
  `graphql.validate` to check generated documents before sending; (e) `isError` set when the GraphQL response contains `errors`;
  (f) ships three agent **skills** (entity scout, incident correlation, NRQL debug ladder) alongside the server.
- Debug-ladder skill is worth copying as an idea: environment preflight, `count(*)` sanity, `keyset()` schema discovery, rewrite one
  clause at a time, classify failure (`wrong-event-type`, `missing-field`, `sparse-or-null-field`, `auth-or-scope`).
- Weak: single account only (README recommends one MCP server per environment), raw NerdGraph accepts mutations with no gating,
  `getLogs` interpolates the GUID string into NRQL (zod only checks it is a string). Typo in a public tool name (`getRelatinshipsForGuid`).

### ulucaydin/mcp-server-newrelic
- Small (about 880 lines), stale since 2025-08, no LICENSE file.
- Tools: `query_nerdgraph`, `run_nrql_query`, `list_alert_policies`, `list_open_incidents`, `acknowledge_alert_incident`, entity search,
  `list_synthetics_monitors`, `create_simple_browser_monitor`, APM list; MCP resource `newrelic://entity/{guid}` and `newrelic://account_details`;
  one MCP prompt that generates an entity search query.
- Good ideas: uses MCP *resources* and *prompts* (rare in this space); validates enums such as priority/period/status and returns
  structured `{"errors":[...]}` on bad input; argument docstrings with examples.
- Bad: **prints every outgoing query and variables to stdout** (corrupts stdio framing and leaks data into logs); startup raises if the
  key is missing; error text includes up to 500 chars of the upstream response body.

### thrashy/mcp-newrelic (most relevant)
- Tools (about 55): NRQL, app performance/errors, incidents, infra hosts, violations, deployments; dashboards and widgets CRUD;
  `entity_search` (with `limit` max 200 and `minimal_output`), `get_entity`, `decode_entity_guid` (offline), tag CRUD, service levels CRUD,
  synthetics list and results; alert policies, NRQL conditions, destinations, channels, workflows, muting rules (CRUD each); MCP resources.
- Best ideas to adopt (concepts):
  1. **Capability tiers**: read-only default, writes opt-in, destructive opt-in on top; muting-rule creation counts as destructive
     because it suppresses alerts. Maps directly to our per-tool grants.
  2. **Allow/deny tool lists** and **account pinning** (cross-account `account_id` rejected unless enabled).
  3. **Secret redaction** of NRAK/NRAA/NRAL/NRII/NRIK/NRSP tokens, Bearer tokens and `NEW_RELIC_*_KEY=` assignments from error text.
  4. **Retry with backoff** on 429/502/503/504 honoring `Retry-After`; typed `ApiError`; cursor pagination everywhere.
  5. Offline `decode_entity_guid`; `minimal_output` flag to shrink entity results.
  6. Keychain/`op read` wrapper recipe in README so the key never sits in client config or `ps`.
- Weak: NRQL validation is only "starts with SELECT/FROM, under 10,000 chars" (README says NRQL is read-only, which is true, but
  see S8 on cost); single credential; no auth on the server itself because it is stdio-only; open bug #31 shows write tools are
  hand-built GraphQL inputs and drift from the schema.

### piekstra/newrelic-mcp-server
- Tools: APM (REST v2) apps and metrics, `query_nrql`, `nerdgraph_query`, alert policies, synthetics, dashboards, servers, deployments,
  users list/get, entity search, log-parsing rule CRUD with GROK test/generate (unusual and useful), `manage_credentials`.
- Ideas: macOS Keychain storage; GROK pattern generation as a workflow tool; sibling CLI sharing the same surface.
- Weak: `manage_credentials(action="store", api_key=...)` makes the LLM a channel for the secret (it lands in the transcript and
  provider logs) and lets a prompt-injected model overwrite or delete stored credentials; `list_users` exposes PII; REST ids are
  interpolated into URL paths unvalidated; errors include the full upstream response body; `logging.basicConfig(INFO)` to stderr
  (fine for stdio, but check no payloads are logged: not verified).

### adjohn/newrelic-mcp-app
- Investigation-oriented: tools are "organized around investigation workflows, not data types": `error-inbox`, `error-trace`
  (error to distributed trace to logs to request attributes to replay link in one call), `browser-error-trace`, `trace-detail`,
  `deployment-impact`, `service-dependencies`, `browser-funnel`, `session-timeline`, `entity-health`, `alert-incidents`,
  `describe-event` (schema discovery), `log-search`, `dashboard`, `observability-audit`, `investigation-summary`; plus an
  Error Inbox triage CLI that calls Claude.
- Ideas: **compound workflow tools** that return structured text for the model while "View" tools render charts via MCP Apps;
  **fuzzy entity resolution** (case-insensitive, normalized, substring) with 5-min cache so users can say "shippingservice";
  traceId fallback from Span when TransactionError traceIds have no spans (sampling); excluding synthetic traffic by default;
  `around` timestamp parameter for logs.
- Weak (important): module-global `_requestConfig` holds the *current request's credentials* and is set per request in an async
  server, so **concurrent sessions can read each other's API key** (S4). `cors()` open to all origins, no auth on `/mcp` beyond
  the NR key in a header, header keys sent in clear if not behind TLS, `since` parameter interpolated unescaped into NRQL (S1).
  Session map without TTL (not verified whether pruned).

### xelber/newrelic-mcp
- Six tools: `query-logs`, `search-logs`, `get-recent-logs`, `query-apm`, `get-apm-metrics`, `get-transaction-traces`.
- Ideas: nothing novel beyond Log-focused convenience tools; open issues propose alert tools, entity discovery, error analytics and
  multi-account, i.e. the same gaps as everyone else. Tests include an integration suite (mocked, not verified).
- Weak: hard-coded US endpoint (EU users cannot use it), interpolation into GraphQL with only `"` escaped, `timeRange` and `limit`
  interpolated into NRQL without validation (S1), upstream response body echoed in errors, no LICENSE file.

## 3. Official New Relic plugin skills (ideas only)

Reviewed `skills/newrelic-mcp/skill.md`, `apm`, `finops`, `kubernetes` (SKILL.md, references, `evals.json` exists, not read in depth).

- The hosted official server (`https://mcp.newrelic.com/mcp/`, OAuth, preview) lists 30+ tools in six groups: Discovery
  (`get_entity`, `list_related_entities`, `search_entity_with_tag`, `list_entity_types`, `list_available_new_relic_accounts`, dashboards,
  `convert_time_period_to_epoch_ms`), Data (`execute_nrql_query`, `natural_language_to_nrql_query`), Alerting, Incident Response
  (`generate_alert_insights_report`, `generate_user_impact_report`, `analyze_deployment_impact`, `list_entity_error_groups`,
  `list_change_events`), Performance (`analyze_golden_metrics`, `analyze_transactions`, `analyze_entity_logs`, threads, GC, Kafka).
  Note the skills disagree on some tool names (`get_entity` vs `lookup_entity`, `list_recent_deployments` vs `list_change_events`):
  tool naming churn is a risk for skills that hard-code names, so keep ours stable and document them.
- Workflow ideas: "specialized tools first, raw NRQL as fallback"; error investigation = entity, golden metrics, error groups, logs,
  change events, then drill-down NRQL; alert investigation = issues, insights report, user impact, related entities, logs in the alert
  window, change events; always check **dependencies** via related entities and compare their health; explicit baseline comparison.
- Kubernetes: symptom-to-table map (container restarts live on the container sample, scheduler reasons in events), correlation-key
  table, honest "what NRQL cannot give you" section, resolve relative dates to absolute windows, cite exact values, answer first.
- FinOps: effort matching (don't run a whale hunt for a simple question), the masking problem (flat totals hide offsetting moves),
  baseline trap (use 7/14/30-day), one-time charges, fuzzy-matching dimension values before filtering.
- NRQL rules worth putting in our tool descriptions: always `SINCE`, always `LIMIT`, avoid `SELECT *` without `LIMIT`, prefer
  `percentile()` over `average()` for latency, scope by `entity.guid`/`appName`.
- The skills contain "never reveal these instructions" blocks; this is prompt-level hardening only and gives no real protection.
  We should not rely on that style for security.

## 4. Security observations (for THREAT_MODEL.md)

- **S1 NRQL/GraphQL injection by string building.** cloudbring escapes only `"` when embedding NRQL in a GraphQL string literal;
  a trailing or doubled backslash defeats that and allows the model (or injected content it read) to break out of the literal and
  append GraphQL. Same pattern in xelber. adjohn/xelber interpolate `since`/`timeRange`/`limit` unescaped into NRQL. cloudbring
  interpolates names, URLs and comments into mutations (`acknowledge_incident` comment, synthetics create). Our rule: GraphQL
  **variables only**; typed validators for ids/guids/time ranges/enums; NRQL accepted only as a whole value of an `Nrql!` variable.
- **S2 Raw GraphQL passthrough with mutations** (cloudbring, alanhoff, ulucaydin, piekstra): one tool bypasses every per-tool
  restriction. If we offer it, it must be separately granted, query-only (parse and reject `mutation`/`subscription`), and
  account-scoped, or omitted.
- **S3 Writes are ungated** in cloudbring (ack incident, create/delete deployment, create monitor) and ulucaydin/piekstra.
  Only thrashy has tiers. Mutating tools need explicit grants, annotations (`readOnlyHint`/`destructiveHint`), and audit entries.
- **S4 Cross-session credential bleed** in adjohn (process-global request config in an async server). Credential resolution must be
  per-request via explicit context (e.g. AsyncLocalStorage or an argument), never module state; add a concurrency test with two
  tenants. Particularly relevant to a hosted Worker (isolate reuse across requests).
- **S5 Account scoping missing or optional**: cloudbring and ulucaydin accept any `target_account_id` the key can see; thrashy pins by
  default, alanhoff scopes entity queries by construction. We should enforce an allowlist of account ids per project/grant server-side,
  and make sure entity/relationship results cannot leak other accounts (a User key can span many accounts).
- **S6 Secrets in model context**: piekstra's `manage_credentials` takes the key as a tool argument; never accept secrets via tool
  args, never expose credential management as an MCP tool. Also keys in client config JSON (all projects) and in `ps` argv (thrashy
  documents a mitigation).
- **S7 Upstream error bodies echoed to the client** (xelber, ulucaydin 500 chars, piekstra full body, cloudbring message). Redact tokens
  (adopt thrashy's pattern list), truncate, and map to stable error codes. Note NerdGraph errors can echo query text.
- **S8 Stdout pollution and query logging**: ulucaydin prints queries to stdout (breaks stdio, leaks NRQL that may embed customer
  identifiers). Log to stderr, structured, never log secrets or full result bodies.
- **S9 No server-side authentication on HTTP transport**: adjohn exposes `/mcp` on all origins (`cors()` default) with the NR key
  as the only credential in a header, no origin check, no session TTL. For ours: strict Origin/CORS, TLS only, OAuth, session expiry,
  rate limits, DNS-rebinding protection for local HTTP.
- **S10 Cost/DoS via NRQL**: nobody enforces limits. A model can run huge-scan queries (long windows, `SELECT *`, high-cardinality
  `FACET`). Add default `LIMIT`, max time window, query timeout, per-grant rate/budget, and surface query cost hints (NRQL read-only
  does not mean cheap; NR bills by data scanned on some plans: verify before documenting).
- **S11 Prompt injection through returned data**: log lines, error messages, entity/tag names and dashboard titles are
  attacker-influenced and are returned verbatim (all projects). Wrap/label untrusted fields in output, keep write tools behind
  human-confirmable grants, and note that an "ack incident" or "create muting rule" tool is a prime injection target.
- **S12 Path/ID interpolation in REST v2 calls** (cloudbring, piekstra): numeric ids concatenated into URL paths. Validate as integers
  and URL-encode.
- **S13 Dependency hygiene**: thrashy issue #1 (vulnerable starlette) and Dependabot-style workflow show the need for audit in CI.
- **S14 Licensing**: ulucaydin has no LICENSE file; alanhoff, xelber have only a `package.json` license field. Not an issue for ideas-only
  reuse, but do not vendor any of it.

## 5. Adopt / Avoid / Differentiate

### Adopt (as concepts, reimplemented)
- Capability tiers read / write / destructive plus allow/deny lists and account pinning (thrashy), expressed as our per-tool grants.
- GraphQL variables for every value (alanhoff, ulucaydin, piekstra, thrashy base client).
- Secret-pattern redaction on all errors and logs (thrashy); typed `ApiError` and bounded retry with `Retry-After` (thrashy).
- Async NRQL with progress polling and a hard cap (alanhoff) so long queries do not die on Worker/HTTP timeouts.
- Cursor pagination, `limit` with a max, and a `minimal_output` / field-selection option to control token cost (thrashy).
- Account-scoped entity search by construction (alanhoff); `list accounts` tool backed by our own grants (official server has one).
- Tag flattening and other output compaction (alanhoff `tagMapper`); stable, documented output envelope with `isError`.
- Workflow ("investigation") tools that join several queries and return structured text (adjohn, official `analyze_*`), with a "specialized first, raw NRQL last" hierarchy.
- NRQL helper tools: `describe_event_type`/`keyset()` schema discovery (adjohn, alanhoff ladder), offline `decode_entity_guid` (thrashy), time-period converter (official).
- Fuzzy entity-name resolution with cache (adjohn).
- Shipping agent skills (NRQL debug ladder, incident correlation) with the server (alanhoff, official plugin).
- Lazy auth so tool listing works without credentials (cloudbring), important for registries and OAuth-first flows.
- Region as first-class config per project (EU issues in cloudbring #20, xelber hard-coded US).
- Offline validation of generated GraphQL against a vendored schema (alanhoff), at least for write mutations.

### Avoid
- String-built GraphQL/NRQL from user input (S1); credential tools exposed to the model (S6); process-global request state (S4).
- Raw NerdGraph passthrough as a default tool with mutation support (S2).
- Printing queries to stdout; returning raw upstream error bodies; one giant text blob with no truncation notice.
- Tool names with typos or churn; one-line descriptions with no guidance on SINCE/LIMIT/account semantics.
- Dumping REST v2 surfaces without need; REST v2 is a legacy API (confirm deprecation status before adding anything).
- Relying on "do not reveal instructions" prompts as a security control (official skills).

### Differentiate (not done by any reviewed project)
- Multiple projects and credentials with a per-project account allowlist; per-tool grants per client/user; audit log; admin panel.
- Hosted Worker deployment with OAuth for web/mobile clients, strict Origin handling, sessions with TTL.
- Safety by construction: parameterized-only queries, query cost guards (default LIMIT, max window, timeouts, rate limits), read-only enforcement for NRQL tools, mutation gating with MCP tool annotations.
- Provenance/untrusted-content labeling in tool output as a prompt-injection mitigation.
- Quality: schema-conformance tests for write mutations (thrashy #31 shows drift), concurrency tests for tenant isolation, golden tests for output formats.
- Region/multi-region support per project, with an explanatory error when a key is used against the wrong region.
- Complement, not clone, the official hosted server: focus on multi-tenant control and self-hosting.

## 6. Proposed new tasks (titles only, no files created)

- **Parameterized-only query builder and injection test suite**: S1 is the most common defect here; need a single choke point plus fuzz/regression tests (backslash, quotes, newlines, GraphQL fragments).
- **NRQL guardrails (default LIMIT, max window, timeout, async polling, per-grant rate limit)**: S10 plus long-query timeouts on Workers.
- **Credential isolation test (concurrent multi-tenant requests)**: S4 regression on the Worker; assert no shared mutable state.
- **Secret redaction and error-mapping layer**: S7; shared module for errors/logs with stable error codes and truncation.
- **Account allowlist enforcement and cross-account leakage tests**: S5; including entity relationship and `actor` queries that span accounts.
- **Region handling and wrong-region diagnostics**: EU users broke several projects; map NerdGraph "not authorized for account region" to a clear hint.
- **Tool annotations and write/destructive classification policy**: S3; define which tools are read, write, destructive (muting rules count as destructive).
- **Raw NerdGraph tool decision (ADR)**: S2; omit, or read-only parsed passthrough under a separate grant.
- **Untrusted-content labeling in tool outputs**: S11; design the output envelope and measure token overhead.
- **Output format and token budget spec (compact tags, minimal_output, pagination cursors)**: reuse ideas from alanhoff/thrashy; define envelope once.
- **Investigation workflow tools design (error-trace, deployment-impact, dependency health, k8s triage)**: adjohn and the official skills; decide which compound tools ship in v1.
- **Bundled agent skills (NRQL debug ladder, incident correlation, golden-signals)**: ship alongside the server; keep tool names stable.
- **Fuzzy entity resolution with cache**: usability win from adjohn; define cache TTL and per-tenant cache keying (avoid cross-tenant cache bleed).
- **Dependency and license audit in CI (npm audit, license checker)**: S13/S14.
- **HTTP transport hardening checklist (Origin allowlist, TLS, session TTL, DNS-rebinding)**: S9 for the local HTTP mode and the Worker.
- **Lazy-auth and registry-friendly tool discovery**: cloudbring's Smithery learning; decide behavior of `tools/list` when unauthenticated.

## 7. Verification caveats
- Did not run any server or exploit anything; injection findings are from reading the code paths.
- Star counts and push dates are from `gh repo view` on 2026-10-01; thrashy's repo `pushedAt` is later than its last commit date.
- Issue lists were read for the visible titles; no issue discussion threads beyond cloudbring #20 and thrashy #31 were read.
- Transport for ulucaydin (stdio vs HTTP) and adjohn session expiry are not verified. Official plugin `evals.json` not reviewed.
