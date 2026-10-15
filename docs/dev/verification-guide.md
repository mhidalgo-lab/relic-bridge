# Verification guide: release checks that need a live account

The offline suites cover every path with recorded NerdGraph fixtures. A few behaviours depend on how New Relic and real
MCP clients behave, so a release verification run checks them by hand against a real (sandbox) account. This page
collects the recipes asked for by the 0.9.1 verification report. Evidence you record from a team account uses
placeholders (`<APP>`, `<account>`, `<entity guid>`, `<issue id>`), never real ids, names or messages.

- [Async query handles](#async-query-handles-run_nrql--get_query_result): make `run_nrql` return a pending handle and
  finish it with `get_query_result`.
- [Write tools](#write-tools): the step-by-step sandbox plan is [write-tools-sandbox-test.md](write-tools-sandbox-test.md).
- [After an upgrade: reconnect](#after-an-upgrade-reconnect-the-client): why a client does not see new parameters.

## Async query handles (`run_nrql` → `get_query_result`)

The 0.9.1 report noted that "no query was slow enough to return a pending handle". relic-bridge has no test hook for
this on purpose; the real path can be reached with `timeout_seconds` and a heavy query.

### What the server does

From `packages/core/src/tools/query.ts` and `packages/core/src/nrql/engine.ts`:

1. `run_nrql` submits the query to `actor.account(id).nrql(query, timeout: <timeout_seconds>, async: true)`.
   `timeout_seconds` accepts 1 to 120 (default 10).
2. If New Relic answers with `queryProgress.completed: false`, the server (mode `auto`) waits
   `min(10, max(1, retryAfter))` seconds and polls `nrqlQueryProgress` **up to 3 times** in the same tool call, while
   the per-call budget allows.
3. Still running after the last poll: the result is `status: "pending"` with `queryId`, `accountId`,
   `retryAfterSeconds` and, when New Relic gives one, `expiresAt`. The text says
   `The NRQL query is still running in account <account> (query id <id>).` and
   `Call get_query_result with query_id "<id>" and account <account> in about <n> s.`
4. `get_query_result` polls once: `pending` again (with a new `retryAfterSeconds`) or the complete result, in the same
   output schema as `run_nrql`.

So `timeout_seconds: 1` alone is not enough: the query must still be running after the 1 s submit **and** three polls,
roughly 4 to 30 s depending on New Relic's `retryAfter`. A handle is never returned when:

| Condition | Why |
|---|---|
| Several `accounts` | Cross-account NRQL is synchronous at New Relic (no actor-level poll). |
| A cached result exists | The query cache answers a complete result at once. Pass `cache: "bypass"`. |
| The account cannot run async NRQL | The submit fails with an async / Data Plus error and the server re-runs it synchronously with the 120 s timeout. The server log shows `nrql async unavailable, falling back to sync` (info level). |
| The client accepts MCP Tasks (2026-07-28 with `io.modelcontextprotocol/tasks`) | The slow query becomes a task right after the submit (no inline polls); the client polls `tasks/get` and the server finishes it with the same `getQueryResult` code. You see a task, not a handle. Use a client without Tasks, or start the server with `RB_TASKS=off`, to see the handle. |
| `rawNrql: false` | `run_nrql` and `get_query_result` are not offered at all. |

### Recipe

Use a sandbox project whose account holds a lot of data (logs or spans over several days). Keep the default
`maxWindowDays` (7) or raise it on the sandbox project only.

1. Connect a client **without** MCP Tasks support (or run the server with `RB_TASKS=off`) and call `whoami`: note
   `limits.maxWindowDays`, `limits.maxLimit` and `limits.perCallBudget` (at least 4: one submit plus three polls).
2. Call `run_nrql` with one account, `timeout_seconds: 1` and `cache: "bypass"`, and a query that scans a lot and
   aggregates little. Examples (replace the placeholders, keep `SINCE` within `maxWindowDays`):

   ```json
   { "nrql": "SELECT count(*) FROM Log WHERE message LIKE '%<rare text>%' FACET hostname LIMIT MAX SINCE 7 days ago",
     "timeout_seconds": 1, "cache": "bypass" }
   ```

   ```json
   { "nrql": "SELECT uniqueCount(trace.id), percentile(duration.ms, 50, 95, 99) FROM Span FACET name LIMIT MAX SINCE 7 days ago TIMESERIES 1 hour",
     "timeout_seconds": 1, "cache": "bypass" }
   ```

   A leading-wildcard `LIKE` over a week of `Log`, or a high-cardinality `FACET` with `TIMESERIES`, is the usual
   way to make NRDB work for more than a few seconds. `LIMIT MAX` may be lowered to `maxLimit`; a note says so.
3. Expected: `status: "pending"`, a `queryId`, `accountId` = the account, `retryAfterSeconds` >= 1, usually
   `expiresAt`. If the result is `complete`, record `durationMs` and try a heavier query or a wider window. Record the
   query shape (not the data) and `durationMs`.
4. Wait `retryAfterSeconds`, then call `get_query_result` with `{ "query_id": "<queryId>", "account": <account> }`.
   Expected: `pending` with a new `retryAfterSeconds`, or `complete` with `results`. Repeat until complete.
5. Negative checks on the same handle:
   - `account` set to an account that is not on the connection: `RB_AUTH_FORBIDDEN`, nothing sent to New Relic.
   - A well-formed id New Relic does not know (change one character): `RB_QUERY_NOT_FOUND`, hint "Rerun run_nrql".
   - The real id after `expiresAt`: `RB_QUERY_NOT_FOUND`.
6. Record the outcome in [RESEARCH](../RESEARCH.md) next to the P8-27 note ("a pending handle cannot be forced on live
   data"): which query shape produced a handle, how long it ran, whether the account fell back to sync.

If New Relic answers the 1 s submit with a timeout error instead of a handle (`RB_NERDGRAPH_TIMEOUT`, "did not finish
within 1 s"), that is a finding: record it, it means the account does not return handles for async submits.

The offline coverage of this path (handles, polls, expiry, `RB_QUERY_NOT_FOUND`, tasks) is in
`packages/core/test/nrql-engine.test.ts` and `packages/core/test/tools-query.test.ts` (fixture
`nrql_async_start.json`).

## Write tools

The four write tools (`create_change_event`, `acknowledge_issue`, `close_issue`, `create_dashboard`) are verified only
against a sandbox account, by the owner, with the plan in [write-tools-sandbox-test.md](write-tools-sandbox-test.md):
account setup, the exact calls with their expected outputs, and the list of what must never happen.

## After an upgrade: reconnect the client

The HTTP transport (`serve`, Docker, the Worker) is stateless (P2-06, ADR-0005): one MCP server per request, so there
is no session to push `notifications/tools/list_changed` to, and it advertises `tools.listChanged: false`
([RESEARCH](../RESEARCH.md), "Tool-list change signalling on stateless HTTP"). A client keeps the `tools/list` it
fetched when it connected. After a server upgrade it does not see new tools or new parameters until it reconnects
(Claude Code: `/mcp`; other clients: remove and re-add the connector, or restart the app). Output fields added by an
upgrade do not break it (output schemas tolerate extra fields since 0.9.0). On stdio the client starts the server
process, so restarting the client runs the new version.

In a verification run, **reconnect every client after upgrading the server, before testing new parameters**; a
"parameter rejected" or "unknown parameter" right after an upgrade is a stale tool list, not a bug. Whether to change
this (for example by keeping sessions so the server can announce list changes) is an owner decision, not part of a
verification run.
