---
"relic-bridge": minor
---

HSTS is on by default for a public https server. When `RB_PUBLIC_URL` is an https URL and `RB_HSTS` is unset or
`auto`, `relic-bridge serve` now sends `Strict-Transport-Security: max-age=31536000; includeSubDomains` on every
response, even though it sees plain http behind a TLS-terminating proxy. Before, it was only sent with `RB_HSTS=true`
or when the request itself arrived over https. `includeSubDomains` makes browsers use https for every subdomain of
that host for a year: set `RB_HSTS=false` if other hosts under the same domain still serve plain http. An https
`RB_PUBLIC_URL` does not declare a TLS proxy: pass-through still needs `RB_HSTS=true` to accept plain-http requests
from the proxy. On Cloudflare Workers, the `503` answered while the Worker cannot start now carries HSTS too.
