---
'relic-bridge': patch
---

Golden metrics: the value and trend now ignore the time bucket that is still filling (no more "throughput 0" or a false drop), the trend compares equal halves of the complete buckets, `timeseries: false` really returns one aggregate without `TIMESERIES`, signals read "down 39%" instead of "down -39%", and query adjustments such as "LIMIT MAX replaced" are stated once instead of on every metric.
