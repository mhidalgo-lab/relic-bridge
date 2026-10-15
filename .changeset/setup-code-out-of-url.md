---
"relic-bridge": minor
---

Setup links keep their one-time code out of URLs, logs and `Referer`. A link now looks like `<RB_PUBLIC_URL>/auth/setup?provider=<id>#setup=rb_setup_…`: the code is in the URL fragment, which browsers never send to a server, and a small setup page posts it in a same-origin form before the sign-in choice. Links with the code in the query string (`?setup=`) are refused with a page that asks for a new link.

Upgrade note: setup links created before this version no longer work; issue a new one with `relic-bridge setup-link`.
