---
id: P6-07
title: "Tools: analyze_threads, list_gc_metrics, analyze_kafka_metrics"
phase: 6
status: done
priority: medium
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-07 — Tools: analyze_threads, list_gc_metrics, analyze_kafka_metrics

## Scope
All three are read-only, group `performance`, phase 6, NRQL only via the `nrql` tag (T4), through the normal query limits
(window cap, event-type allow/deny). Metric and event names come from documentation and are **unverified** (RESEARCH).
- `analyze_threads` (`entity_guid`, `time_range` default last 1 hour, `minimal_output`): JVM thread states, thread counts,
  CPU and heap of an APM Java entity from agent `Metric` timeslices (`Threads/SummaryState/*`, `JmxBuiltIn/Threads/*`,
  `CPU/*`, `Memory/Heap/*`), filtered by `entity.guid`; per metric name average, peak and samples. Two queries (threads, CPU
  and memory), cost 2, partial when the budget stops one.
- `list_gc_metrics` (`entity_guid`, `time_range`, `minimal_output`): garbage-collector (`GC/*`) and heap (`Memory/Heap/*`)
  timeslices of one entity, one query, cost 1: per metric name average, peak, total and samples.
- `analyze_kafka_metrics` (`account`, optional `cluster_name`, `consumer_group`, `topic`, `time_range`, `minimal_output`):
  consumer lag per group/topic with partition balance (`KafkaOffsetSample`), topic throughput (`KafkaTopicSample`), broker
  throughput (`KafkaBrokerSample`). Three queries, cost 3, one account per call; a part with no rows is reported as "no data
  for this account" with the event type it looked for, and a part the budget stops is reported (`partial`).
- Names of threads, topics, consumer groups, clusters and metrics are written by the monitored systems (T6): `cleanName`,
  shown inside the untrusted-data envelope.

## Acceptance criteria
- [x] Graceful "no data for this entity/account" responses (never an error), naming what was looked for.
- [x] Fixture + contract tests; account filtering enforced (P2-12 `TOOL_CASES`).
- [x] NR-supplied names enveloped and capped; injection tests; hostile filters escaped via the `nrql` tag; event-type deny tested.
- [x] Budget-aware; partial result tested; accurate `cost`.
- [x] `docs/reference/tools.md` regenerated; THREAT_MODEL, RESEARCH updated; owner decisions logged.

## Security notes
T3 (account from the GUID, or `account` for Kafka), T4 (`nrql` tag only), T6 (names written by monitored systems).

## Docs to update
- Tool reference (generated), THREAT_MODEL, RESEARCH.

## Out of scope
- Thread dumps / profiler stack traces, non-JVM runtimes, OpenTelemetry Kafka metrics, MSK/Confluent cloud integrations
  (a follow-up if the event types differ), per-partition time series.
