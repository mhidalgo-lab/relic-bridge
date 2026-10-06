---
id: P7-01
title: "Result shaping v2: summaries, downsampling, stats"
phase: 7
status: review
priority: medium
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-01 — Result shaping v2: summaries, downsampling, stats

## Scope
- `run_nrql` / `get_query_result` take `detail`: `auto` (default), `summary`, `full`.
- `auto` summarizes a result of at least 50 rows that is a timeseries or has FACETs (raw-event lists are never
  summarized by `auto`: the agent needs the rows). `summary` forces it, `full` never summarizes (rows up to `max_rows`).
- Timeseries: downsampled per series (consecutive points averaged, time order kept, at most 10 series and 24 points
  per series), exact stats over every point read, and robust (median/MAD) anomaly hints. Faceted tables: first 25
  rows (NRDB ranks them), exact stats over all rows and the sum of the rows not shown ("others").
- Stats: count, min, max, avg, p50, p95 per numeric column (at most 8 columns). Bounded work: at most 5000 rows read.
- Everything derived from New Relic text (column names, facet values) is inside the untrusted-data envelope in the text;
  `structuredContent.summary` carries it redacted (documented residual, as for rows).
- "Full pages via handle": `detail: "full"` with `max_rows` re-runs the query (the query cache, P7-02, makes the re-run
  cheap). A server-side result handle with paging is out of scope until P7-02 exists (see below).

## Acceptance criteria
- [x] Token usage reduced >= 50% on large-result eval cases without accuracy loss
  (`packages/core/test/summarize.test.ts`: three large cases, text + structured tokens < 50% of the default full
  output; stats compared with exact values).
- [x] Downsampling and stats are bounded and benchmarked (`tool.run_nrql.summary2000` in `bench:cpu`).
- [x] Summary text lines that include New Relic text are inside the envelope; tools/list stays within budget.
- [x] Output formats guide updated.

## Security notes
Summaries add New Relic-derived text (facet values, column names) to the result; they go inside the envelope like rows,
and `structuredContent.summary` is redacted but not enveloped (same residual as `rows`, THREAT_MODEL T6). Work is
bounded (5000 rows, 10 series) so a hostile result cannot burn CPU (T5).

## Docs to update
- Output formats guide (`docs/guide/output-formats.md`).

## Out of scope
- Server-side result handle with paging over a stored result: depends on the query cache (P7-02); not split into a new
  task because P7-02 can offer it. Other tools' (non-NRQL) summaries.
