---
'relic-bridge': patch
---

Tool output schemas no longer forbid extra properties, so a client that connected before an upgrade no longer rejects results that gained fields (for example `whoami` after 0.7.0 to 0.8.0, NEW-01). Input validation is unchanged. **Reconnect your MCP client after upgrading relic-bridge** to see new tools and parameters: a stateless server cannot signal a changed tool list.
