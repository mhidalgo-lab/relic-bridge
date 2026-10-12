---
'relic-bridge': minor
---

Name lookups can be narrowed with optional `domain` and `type` (for example `domain: "APM"`) on every tool that takes `name`, so an app that also has a same-named browser entity no longer fails with an ambiguity error. The ambiguity error now suggests `domain`. APM-only tools (transactions, deployment impact, threads, GC) keep resolving a bare name to the APM entity.
