---
'relic-bridge': patch
---

Self-monitoring gives the New Relic service entity throughput and response time: relic-bridge now exports the OpenTelemetry `rpc.server.duration` metric (New Relic builds the golden metrics from it), adds `telemetry.sdk.*` and a random per-process `service.instance.id` to the resource, and names spans `tools/call <tool>` so Errors Inbox groups are distinct per tool.
