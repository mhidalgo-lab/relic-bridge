---
'relic-bridge': minor
---

`maxWindowDays` now limits how far back a query reads as well as how wide it is: `SINCE 60 days ago UNTIL 59 days ago` (and the same with dates, epoch seconds or milliseconds, `COMPARE WITH` offsets, or subqueries) is refused with `RB_LIMIT_QUERY`, in `run_nrql` and in every tool that reads a time window. Exactly `maxWindowDays` days is still allowed.
