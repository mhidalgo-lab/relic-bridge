---
"relic-bridge": minor
---

More security events reach the audit log. A successful OAuth authorization and each refresh are recorded (`oauth.token.issue`, `oauth.token.refresh`: user, grant, app, project; never a token or code). A request that cannot open the stored New Relic key records `credential.decrypt_failed` (credential id, project, master key version and the reason; never key material). The hourly audit purge of `relic-bridge serve` records `audit.purge` with `source: schedule`, like the CLI command and the Worker cron. These rows have their own per-minute cap, with an `admin.suppressed` summary row. An expired session still shows as `auth.denied` (`session_idle` or `session_expired`) when its cookie is next presented.
