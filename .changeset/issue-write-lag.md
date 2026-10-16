---
'relic-bridge': patch
---

`acknowledge_issue` and `close_issue` now note, when applied, that New Relic can take a few seconds to show the change,
so a read or dry run right after it may still show the old state (seen in the first live test).
