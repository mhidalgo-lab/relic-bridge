---
'relic-bridge': patch
---

Fix `list_change_events` in account scope returning no APM deployments: the account-wide change feed does not carry deployments recorded through the APM deployment API, so the tool now also reads the deployments of up to 50 of the account's APM applications and merges them (limits are reported in a new `notes` field). Events no longer come back with `type: null`; the type is taken from the category when NerdGraph leaves it empty.
