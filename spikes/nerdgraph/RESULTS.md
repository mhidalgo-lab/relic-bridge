# P0-09 results

Status: **docs research done (2026-10-01); live run pending** (needs User keys — see README).

## A. Verified from public docs

Sources: [Meet NerdGraph](https://docs.newrelic.com/docs/apis/nerdgraph/get-started/introduction-new-relic-nerdgraph/),
[Async NRQL](https://docs.newrelic.com/docs/apis/nerdgraph/examples/async-queries-nrql-tutorial/),
[NRQL tutorial](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-nrql-tutorial/),
[Usage limits](https://docs.newrelic.com/docs/apis/nerdgraph/nerdgraph-usage-limits/),
[Concurrency tutorial](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-concurrency-tutorial/),
[Entities](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-entities-api-tutorial/),
[Relationships](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-relationships-api-tutorial/),
[Golden metrics](https://docs.newrelic.com/docs/apis/nerdgraph/examples/golden-metrics-entities-nerdgraph-api-tutorial/),
[Issues API](https://docs.newrelic.com/docs/apis/nerdgraph/examples/nerdgraph-issues-api-via-github/),
[Live chart URLs](https://docs.newrelic.com/docs/apis/nerdgraph/examples/manage-live-chart-urls-via-api),
[FedRAMP endpoints](https://docs.newrelic.com/docs/security/security-privacy/compliance/fedramp-compliant-endpoints/).

| # | Fact | Impact on relic-bridge |
|---|---|---|
| 1 | Endpoints: **US** `https://api.newrelic.com/graphql`, **EU** `https://api.eu.newrelic.com/graphql`, **JP** `https://api.jp.newrelic.com/graphql`. Header `API-Key`. | **Add JP as a third region** (RESEARCH §6 only had US/EU). |
| 2 | **No FedRAMP NerdGraph endpoint is documented** (the FedRAMP page lists ingest endpoints such as `gov-aws-api…`, not GraphQL). | Don't ship a FedRAMP region; revisit only if a user confirms an endpoint. |
| 3 | NRQL: `actor.account(id) { nrql(query, timeout, async, options) { results … } }`; `results` is required. Cross-account: `actor.nrql(accounts: […], query, timeout, options)`. | As planned (P1-03). |
| 4 | Async: `nrql(…, async: true)` returns `queryProgress { queryId completed retryAfter retryDeadline resultExpiration }` if not done within the timeout (default 5 s). Poll with `actor.account(id) { nrqlQueryProgress(queryId) { results queryProgress {…} } }`; **the account must match the original query**; the poll can be repeated verbatim. | As planned. `get_query_result` needs `queryId` + account. |
| 5 | Async NRQL docs mention **Data Plus with a 10-minute max query duration**. | **verify live**: whether async works (or is useful) on Original Data accounts. If not, `auto` mode must fall back to sync with max timeout and return a clear error. |
| 6 | Result container also offers `embeddedChartUrl` (live chart URL). Raw NRQL JSON responses carry `performanceStats.inspectedCount`. Other fields (`metadata`, `totalResult`, `otherResult`, `staticChartUrl`, `rawResponse`, `nrql`, `suggestedFacets`) are **not documented** in the tutorials. | Probe selects every field that exists (schema-driven); confirm which carry inspected count. `embeddedChartUrl` is a candidate for P7-03 deep links / charts — note it creates a **shareable public URL**, so it must be opt-in (privacy). |
| 7 | Concurrency: **25 concurrent requests per user** (guaranteed), HTTP **429** beyond. Docs don't describe the 429 body/headers or `Retry-After`; their examples just cap concurrency (semaphore = 25). | Probe captures the real 429. Keep our cap ≤ 5 and backoff with jitter. |
| 8 | `entitySearch(query: String)` syntax: `=`, `LIKE`, `IN (…)`, `AND`, `OR`, `IS [NOT] NULL`, `IS TRUE/FALSE`; strings in **single quotes**; tags as `tags.<key>`; `queryBuilder` alternative (not combinable with `query`); **max 200 entities per page**, `results(cursor:)` + `nextCursor`. **Escaping of `'` inside values is not documented.** | Probe tests `\'`, `''` and an unbalanced quote. Until confirmed, P1-08's escaping helper must **reject** values containing `'` or `\` rather than guess. |
| 9 | `entity(guid) { relatedEntities { results { source { entity {…} } target { entity {…} } type } } }`; filter args not documented. `entity.goldenMetrics { metrics { title query } }`. | Probe reads the real arguments from the schema. |
| 10 | `account(id) { aiIssues { issues(filter, cursor) { issues {…} nextCursor } incidents(filter) {…} } }`. Filter: `ids`, `states` (`CREATED`, `ACTIVATED`, `DEACTIVATED`, `CLOSED`), `priority` (`LOW`…`CRITICAL`), `entityGuids`, `entityTypes`, `timeWindow` (epoch ms; default last 24 h). Docs say the header **`nerd-graph-unsafe-experimental-opt-in: AiIssues`** is required. | Probe runs with and without the header. If it's needed, the client must send it only for aiIssues documents, and P6-02 must treat the API as unstable. |
| 11 | **Errors Inbox (`errorsInbox.errorGroups`) is not documented** in public NerdGraph tutorials. | Probe discovers the signature via introspection (`schema-excerpt.json` → `errorGroupPaths`). P6-03 depends on this. |
| 12 | Change tracking: `actor.changeTracking.changeTrackingSearch(filter: { timeWindow, accountIds, query })` and `entity(guid).deploymentSearch(filter: { timeWindow, query, limit ≤ 200 })`. | Inputs for P6-04 (not probed in this spike). |

GraphQL rule applied throughout: documents are constants; **every value is a variable** (`$nrql: Nrql!`, `$accountId: Int!`,
`$guid: EntityGuid!`, …). The only interpolation is of type names and selection sets read from the introspected schema.

## B. Live run results (2026-10-02, maintainer's 2 keys: 2 different NR users, 2 accounts each, both US)

Raw output stays local (`results/raw/`, gitignored); sanitized copies are in `results/sanitized/`. The probed account (A) has
entities and dashboards but **no recent Transaction/Log data**, so rows marked *inconclusive* need a re-run against an
account with APM traffic (optional, before P1-03/P1-09).

| # | Measurement | Result |
|---|---|---|
| 1 | Key validation | `actor.user { id email name }` + `actor.accounts { id name }` work (~260–360 ms). Each key listed only its own user's 2 accounts. Schema: **`Actor.accounts(scope: RegionScope)`**, so the default listing may be region-scoped (P1-07: pass the scope explicitly). |
| 2 | Variable types | `Account.nrql(query: Nrql!, timeout: Seconds, async: Boolean, options: NrqlQueryOptions)`, `Account.nrqlQueryProgress(queryId: ID!)`, `Actor.nrql(accounts: [Int!]!, …)`, `Actor.entity(guid: EntityGuid!)`, `Actor.entities(guids: [EntityGuid]!)`, `Actor.entitySearch(query: String, queryBuilder, options, sortBy…)`. |
| 3 | Sync NRQL latency | **~3.6 s when selecting every result field**, but **~230–470 ms for `results` only** (timeout, async, burst and error probes). The slowness came from optional fields (`eventDefinitions`, `suggestedQueries`, chart URLs). **P1-03 selects only the fields it needs.** |
| 4 | Result fields | `results`, `totalResult`, `otherResult`, `metadata { eventTypes facets messages timeWindow }`, `rawResponse` (`metadata`, **`performanceStats { inspectedCount matchCount omittedCount wallClockTime exceedsRetentionWindow }`**, **`queryUsage { billableMetric scannedEvents ccu }`**), `nrql`, `queryProgress`. `metadata.messages` carries warnings ("No events found -- do you have the correct event type and time range?"). Optional fields fail **independently** (partial `errors` with `data`): `suggestedQueries` → `UNSUPPORTED_NRQL`, `embeddedChartUrl` → `SERVER_ERROR (403)`. **Merely selecting `staticChartUrl` generated a token-signed public snapshot URL** (T26). |
| 5 | `SHOW EVENT TYPES` / `keyset()` | `SHOW EVENT TYPES` → `results: [{ eventType }]`. `keyset()` works, with the same optional-field errors. |
| 6 | Timeout without async | `timeout: 1` on a fast query → normal results (inconclusive for slow queries). |
| 7 | Async | `async: true` on a fast query completed immediately (`completed: true`, `queryId: null`, 0 polls). Whether Original Data accounts get a `queryId` for slow queries is *inconclusive*. |
| 8 | Cross-account | `actor.nrql(accounts: [a, b])` → 200, no errors (no data rows). |
| 9 | Error shapes | Bad NRQL: HTTP 200, `nrql: null`, `errorClass: INVALID_INPUT`, `errorCode: NRDB:1102004`, message "NRQL Syntax Error: …". Unknown/unauthorized account: 200, `account: null`, `errorClass: ACCESS_DENIED` "Access denied.". Unknown event type: **no error** (`count: 0`), so rely on `metadata.messages`. Missing variable: 200 with GraphQL validation errors, no `data`. |
| 10 | **Wrong region** | **HTTP 403** `{"errors":[{"message":"not authorized for account region"}]}`, the hint trigger for P1-02. |
| 11 | Invalid / ingest-style / empty key | **HTTP 401** `{"errors":[{"message":"authentication required"}]}` for all three, so ingest keys can't be told apart server-side; detect the `NRAK-` prefix client-side. |
| 12 | Burst of 30 | 30 × 200, no 429 (durations 0.3–1.7 s, so NerdGraph queues rather than rejects light queries). 429 shape still *unobserved*. |
| 13 | entitySearch quoting | **`\'` works** (`name = 'it\'s'` valid). `''` and an unbalanced quote → `INVALID_INPUT` "Provided filter … is not a valid NRQL query". So the escaping rule is: backslash-escape `\` and `'`. |
| 14 | entitySearch account scope | All 32 entities returned by an unfiltered search belonged to the key's own accounts (1 account). Cross-user scope is *inconclusive*; P1-08 still filters by allowed accounts. |
| 15 | goldenMetrics | *Skipped* (no APM entity found). |
| 16 | relatedEntities | *Skipped*. |
| 17 | aiIssues header | Works **with and without** `nerd-graph-unsafe-experimental-opt-in: AiIssues` (empty result). Send it anyway; it's harmless and documented. |
| 18 | Errors Inbox | `errorsInbox.errorGroups(cursor, entityGuids, filter: ErrorsInboxErrorGroupSearchFilterInput, query, sortBy, timeWindow: TimeWindowInput): ErrorsInboxErrorGroupsResponse { results nextCursor totalCount }`. |
| 19 | Alert policies | `alerts.policiesSearch` works (shape in sanitized fixture). |

## C. Follow-ups for P0-11

- RESEARCH.md §6: add JP region, remove FedRAMP (unless confirmed), add async Data Plus caveat, aiIssues opt-in header.
- P1-02: region enum `US | EU | JP`; error mapping from measurements 9–11; per-document extra headers (aiIssues).
- P1-03: async availability fallback (measurement 7); timeout semantics (measurement 6).
- P1-08: entity-search escaping rule from measurement 13; account filtering from measurement 14.
- P6-02 / P6-03: API stability notes from measurements 17–18.
- P7-03: `embeddedChartUrl` creates a shareable chart link — opt-in only; record in THREAT_MODEL if adopted.
