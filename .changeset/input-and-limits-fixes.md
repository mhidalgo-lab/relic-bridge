---
"relic-bridge": patch
---

Three input checks are stricter. `RB_OTEL_HEADERS` values must decode to Latin-1 text without control characters (tab allowed): anything else now stops start-up with a configuration error that names the header but not its value, instead of every export failing later. NRQL with unbalanced parentheses is refused before it is sent, so the `LIMIT` added to a raw event query can no longer land inside an open parenthesis. A log field named `ts`, `level` or `msg` is written as `field_ts`, `field_level` or `field_msg` and no longer replaces the record's own timestamp, level or message.
