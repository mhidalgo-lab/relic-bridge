---
"relic-bridge": patch
---

A `${VAR}` reference that the MCP client passed through unexpanded (the variable was not set where the client started) now counts as unset: with no configuration the server starts in setup mode instead of exiting, and with a partial configuration the startup error names the variable.
