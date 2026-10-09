# Tool argument and output naming

One name per concept, in every tool (P6-22). An agent that learned `entity_guid` and `time_range` on one tool can call
the next one without reading its schema twice, and the descriptions do not spend tokens explaining local spellings.
The rules are enforced by `lintNaming` (`packages/core/test/evals/naming.ts`), which runs in `pnpm test` through
`packages/core/test/tool-descriptions.test.ts` for every built-in tool and every prompt. A new tool that breaks a rule
fails the build; fix the name, do not add an exception.

Description style (what to say, in what order) is in [evals.md](evals.md). This page is about names.

## Arguments (input schema)

Arguments are `snake_case`. Prompt arguments follow the same names (they are strings by MCP definition).

| Concept | Name | Type | Notes |
|---|---|---|---|
| One account | `account` | integer | Default: the connection default. With `entity_guid` the GUID implies the account. |
| Several accounts | `accounts` | integer[] | Only `run_nrql` (cross-account query). |
| The entity a tool is about, or filters by | `entity_guid` | string | Never `guid`, also when the tool is about one entity (`get_entity`, `entity_health`). |
| The same entity by name | `name` | string | Only next to `entity_guid`: resolved by the shared resolver (P6-17), exactly one of the two. |
| Substring of a listed object's name | `name_contains` | string | `search_entities`, `list_alert_policies`, `list_alert_conditions`, `list_dashboards`, `list_synthetic_monitors`, `list_top_transactions`. |
| Free text over a row's main text | `contains` | string | Log message, issue title, error group text. A filter on one other field is `<field>_contains` (`query_contains`). |
| The time window | `time_range` | string | Every tool that reads a window, e.g. `"last 6 hours"`, `"2026-10-01 to 2026-10-02"`. Use `timeRangeInput()` from `tools/shared.ts`. |
| A second, longer window | `lookback` (string) or `lookback_days` (integer) | | Only where a tool has two windows: where to find the issue or deployment, while `time_range` is what is measured. |
| A duration as a number | `<thing>_seconds`, `_minutes`, `_hours`, `_days` | integer | `timeout_seconds`, `compare_minutes`, `before_minutes`, `change_lookback_hours`. Never `_s`, `_ms`, `_min`. |
| Most rows to return | `limit` | integer | Rows of the tool's main list. A cap on something else is `max_<things>` (`max_metrics`, `max_rows`, `max_dependencies`). |
| Next page | `cursor` | string | The `nextCursor` of the previous call with the same filters. A tool takes `cursor` only if it returns `nextCursor`, and the reverse. |
| Fewer fields per row | `minimal_output` | boolean | |
| Compare with the window before | `compare_previous` | boolean | |
| An identifier | `<thing>_id` | string | `issue_id`, `policy_id`, `query_id`, `error_group_id`, `trace_id`. Numeric New Relic ids are passed as digit strings, the way the list tools return them. |
| Order | `sort_by` | enum | |

Spellings the lint refuses, with their replacement, are listed in `INPUT_SYNONYMS` (`guid`, `since`, `window`,
`account_id`, `next_cursor`, `page_size`, `max_results`, `compare`, `name_like`, ...).

## Structured output (`structuredContent`)

Output keys are `camelCase`, at every depth of the output schema. Rows that come straight from NRQL (`run_nrql`
`rows`) keep New Relic's column names; they are records, not schema properties.

| Concept | Name | Type | Notes |
|---|---|---|---|
| The account of the result or of a row | `accountId` | integer | Any key holding account ids ends in `AccountId` / `AccountIds` (`dataAccountId`, `defaultAccountId`, `unreachableAccountIds`). `accounts` is only a list of account objects (`list_accounts`). |
| Several account ids | `accountIds` | integer[] | |
| An object's own GUID | `guid` | string | Inside an entity, dashboard, monitor or span object. |
| The entity a result is about | `entityGuid` | string | Top-level reference (`entity_health`, the APM and log tools). |
| The window actually read | `since`, `until` | string (ISO 8601 UTC) | Always both, resolved bounds (not the expression the agent typed). A comparison nests them (`window`, `windows.before`). |
| More pages | `nextCursor` | string \| null | Pass back as `cursor`. |
| A list cut at `limit` or a cap, without paging | `truncated` | boolean | Never `hasMore` or `maybeMore`. The text says how to see the rest (raise `limit`, narrow `time_range`). |
| Matches New Relic reported | `total` | integer \| null | Never `totalCount`. Counts of something else are `total<Things>` (`totalMetrics`, `totalRows`). |
| Rows dropped for being outside the connection's accounts | `hiddenOutsideScope` | boolean | On every list that filters rows by account after fetching them. |
| Not everything ran | `partial` | boolean | With `notes: string[]` saying what is missing. |
| A duration or a rate | ends in its unit | number | `durationMs`, `avgDurationSeconds`, `periodMinutes`, `retryAfterSeconds`, `bytesInPerSecond`. |

## Text output

The text is what most clients show the model. It refers to arguments by their argument name and to structured fields by
their output name, so the two never disagree: a paged tool ends with `nextCursor: <value>` and says "call again with
the same filters and cursor set to the nextCursor below".

## Changing a name

Tool names never change (grants store them). Argument and output names are part of the public contract from 1.0: until
then a rename is listed as breaking in the changeset; after 1.0 the old argument stays accepted as a deprecated alias
(same schema validation) for one minor release.
