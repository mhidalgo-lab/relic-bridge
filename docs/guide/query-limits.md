# Query limits

relic-bridge checks every NRQL query before sending it to New Relic. This covers queries the agent writes itself
(`run_nrql`) and the queries built by the purpose-built tools. The limits keep queries cheap and bounded: they protect
your New Relic account's query capacity and keep responses small enough for the agent (and for the Workers free plan).

Limits are set per connection (project): `limits:` in the YAML config or `RB_LIMITS_*` env vars, see
[configuration](configuration.md). Later releases will let a grant tighten them further (P4).

## The limits

| Setting | Default | What happens |
|---|---|---|
| `maxLimit` | 1000 | `LIMIT n` above it is lowered to `maxLimit`, at any depth (subqueries too). `LIMIT MAX` is replaced by `maxLimit`. Only one top-level LIMIT is allowed, and the value must be plain digits or MAX. A raw event query (`SELECT *` or plain attributes, no FACET) without a LIMIT gets `LIMIT 10`: NRQL's own default (measured), made explicit, or `maxLimit` if that is lower. |
| `maxWindowDays` | 7 | Queries that can reach further back are rejected with `RB_LIMIT_QUERY` and a hint. The window is `SINCE` to `UNTIL`, plus `COMPARE WITH`. Without a SINCE, NRQL's 1-hour default counts. |
| `eventTypes.allow` / `eventTypes.deny` | none | Event types in any `FROM` (including subqueries and JOINs) are checked. NRQL event types are case-sensitive, so allow lists match exactly; deny lists ignore case and surrounding spaces, which also blocks near-miss spellings. A denied or non-allowed type is rejected. With an allow list, a query that names no event type (e.g. `SHOW EVENT TYPES`) is rejected. |
| `rawNrql` | on | When off, `run_nrql` (arbitrary NRQL) and `get_query_result` are not offered at all by the stdio CLI, and refuse with `RB_TOOL_DISABLED` if reached another way. The purpose-built tools still work. |
| `maxResponseBytes` | 512 KiB | Larger responses are cut off while streaming → `RB_LIMIT_RESPONSE_TOO_LARGE`. |

Adjustments (a lowered or added LIMIT) are reported back to the agent as notes, so it knows the result was capped.

## Time expressions understood

Anything else after `SINCE`, `UNTIL` or `COMPARE WITH` is **rejected** rather than guessed (fail closed). Each of these
clauses may appear once at the top level, and numbers must be plain digits (no `1e3`).

- relative: `SINCE 3 hours ago`, `UNTIL 30 minutes ago`. Units: second, minute, hour, day, week, month (30
  days, as NRQL counts it) and year (366), singular or plural.
- calendar: `today`, `yesterday`, `this week`, `last week`, `this month`, `last month`, `this quarter`,
  `last quarter`, `this year`, `last year`. These count as their widest possible span: `last month` = 62 days.
- epoch timestamps in seconds or milliseconds (`SINCE 1790900000` or `SINCE 1790900000000`). Only unambiguous ranges are
  accepted: 10-digit seconds and 13-digit milliseconds.
- quoted dates: `SINCE '2026-10-01 00:00:00'`, or ISO 8601 with a zone. Dates without a zone are UTC, as in NRQL. With
  `WITH TIMEZONE`, quoted dates are widened by 14 hours (the largest time-zone offset).
- `UNTIL NOW`.

## How it works, and its known gaps

The checks use a small tokenizer, not a full NRQL parser. It recognises:
- string literals (`'…'`, `"…"`, backslash escapes) and backtick identifiers;
- comments (`--`, `//`, `/* */`);
- parentheses depth.

A keyword inside a string is never mistaken for a clause, and unterminated quotes are rejected.

**Comments** are allowed, and NRQL reads them exactly as the tokenizer does. That includes `x--1`, which is `x`
followed by a comment, not arithmetic. They're checked out and **removed before sending**, so New Relic receives
exactly the text that was checked. Double-quoted strings are rejected, as NRQL itself does.

An event type glued to punctuation (`FROM Log-Archive`) counts as unresolved, and is rejected when event-type lists are
set.

These rules were measured against NerdGraph by `spikes/nerdgraph/nrql-safety.ts` (results in RESEARCH §2).

Known gaps, stated honestly:

- **Subquery windows:** a `SINCE` inside a subquery is counted from that point up to now (conservative).
- **Raw-query detection:** a select list with any function call (`capture()`, `if()`, …) is treated as an aggregate, so
  no LIMIT is injected. NRQL's own default of 100 rows still applies.
- **Unreadable FROM:** if the `FROM` can't be read (e.g. `lookup(…)`), the query is rejected only when event type
  lists are configured.
- **NRQL dialect:** NRQL features the tokenizer doesn't know may be rejected as unreadable. Report them, and we'll
  teach the tokenizer.

## For tool authors

Never build NRQL from strings. Use the `nrql` tag (see `docs/dev/core.md`): it escapes every value, and
`pnpm lint` fails on untagged NRQL template literals and string concatenation (`scripts/check-nrql-templates.ts`).
