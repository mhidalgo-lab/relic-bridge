---
'relic-bridge': patch
---

Fix `list_synthetic_monitors` failing on every call: the monitor status is now read from `monitorSummary { status }`, because NerdGraph has no `status` field on the monitor outline type.
