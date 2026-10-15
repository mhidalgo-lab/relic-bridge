---
'relic-bridge': patch
---

Hardening from the pre-launch review:

- Event-type allow and deny lists now also cover queries without a `FROM` clause. With a list set, `run_nrql` refuses `SHOW EVENT TYPES` and other FROM-less statements or subqueries (`RB_LIMIT_QUERY`); use `list_event_types`, which respects the lists.
- `COMPARE WITH` inside a subquery is refused with a clear error (New Relic does not support it there).
- Requests to NerdGraph (which carry the User API key) and OTLP exports never follow redirects: a 3xx answer fails the request. This also makes OTLP export work on Cloudflare Workers, which rejects the `redirect: 'error'` mode the exporter used.
- **Behaviour change:** "Don't ask again" on the OAuth consent page is now offered only to apps identified by their client ID metadata document (such as claude.ai). Dynamically registered apps, whose identity is not verified, ask every time. Approvals remembered for them earlier are no longer used or listed.
