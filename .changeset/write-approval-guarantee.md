---
'relic-bridge': patch
---

`whoami`, the write tool descriptions and the guide now say what write approval guarantees: it is answered through the
client's elicitation prompt and bound to the exact change, but the server cannot verify that a person answered it.
`create_dashboard` now warns in a dry run when New Relic rejects widget queries, and a confirmed call checks the queries
with New Relic before asking for approval and refuses (nothing created) when one is rejected.
