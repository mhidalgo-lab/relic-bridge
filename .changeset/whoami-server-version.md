---
'relic-bridge': patch
---

`whoami` now says which relic-bridge answered: an optional `server: { version, runtime }` (`node` or `workers`) and a
text line such as "relic-bridge 0.13.0 (workers)", so two deployments of one project can be told apart.
