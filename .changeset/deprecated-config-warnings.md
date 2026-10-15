---
"relic-bridge": minor
---

Deprecated configuration is now announced where you run it. A new registry lists every deprecated environment
variable, config-file key and CLI flag with its replacement and the release that removes it. While you use one,
`relic-bridge serve` and the stdio server print one warning per name on stderr at startup, the Cloudflare Worker logs
one warning per deprecated variable once per isolate, and `relic-bridge doctor` adds a `deprecated-config` line for
each (one `ok` line when there is none). Only the name is shown, never its value. Nothing is deprecated today, so the
list is empty and only the `doctor` line is new.
