# Logging inventory

What relic-bridge logs, where it goes, what is protected, how long it is kept and who can read it. Written for
[OWASP ASVS 5.0](asvs-l2.md) V16.1.1 and V16.2.3. Every section was checked against the code (file and function named);
gaps are listed with the task that covers them.

**Reviewed:** 2026-10-15 (P8-72), against `main` at 0.11.0. Paths are relative to the repository root.

## Sinks at a glance

| Sink | What | Format | Where it goes | On by default | Retention | Readers |
|---|---|---|---|---|---|---|
| [Structured log](#structured-log-stderr) | Diagnostics, one access line per HTTP request, boot and warning lines | One JSON object per line | stderr (Node: `serve`, stdio, CLI); Workers Logs (Worker) | yes | Operator's (Node); Cloudflare's: 3 days on Workers Free, 7 days on Paid | Whoever reads the process output; Cloudflare account members with Workers observability access |
| [Audit log](#audit-log) | Tool calls, refusals, sign-ins, admin changes, write intents | Rows in table `audit_log` | The application database (SQLite file for `serve`, D1 for the Worker) | yes (`RB_AUDIT=on`) | 90 days (`RB_AUDIT_RETENTION_DAYS`) | Owners and admins (all rows), members (their own rows), the bootstrap admin token, anyone with database access |
| [OTLP export](#otlp-export) | Metrics, one span per MCP request, and the structured log through an allowlist | OTLP/HTTP JSON | The collector at `RB_OTEL_ENDPOINT` (https) | no (`RB_OTEL=on`) | The collector's (New Relic: per its data retention) | Whoever can read that collector |

stdio has no audit database: write tool calls are recorded on stderr instead (`apps/cli/src/stdio.ts`, `write tool call`
lines: tool, status, error code and the tool's own write record, never the arguments' text).

## Structured log (stderr)

**Code:** `packages/core/src/logger.ts` (`createLogger`, `stderrSink`), redaction in `packages/core/src/redact.ts`.

- **Sink:** `console.error`, which is stderr on Node (stdout is the stdio MCP channel and is never used for logs) and
  Workers Logs on the Worker (`apps/worker/wrangler.jsonc` sets `observability.enabled`).
- **Third-party output:** the CLI points `console.log` and `console.info` at stderr (`apps/cli/src/index.ts`), so a
  dependency can't write to the stdio MCP channel; such lines bypass our redaction (the OAuth provider can print one fixed
  warning when it is imported).
- **Levels:** `debug`, `info` (default), `warn`, `error`; `RB_LOG_LEVEL` (`apps/cli/src/main.ts`,
  `apps/worker/src/settings.ts`). An unknown value is ignored with a warning.
- **Record:** `{"ts": ISO 8601 UTC, "level", "msg", ...fields}` serialised whole with `JSON.stringify`, one line each.
  Child loggers add fixed fields: `app: "relic-bridge"` (CLI), `requestId` and `tool` (tool calls,
  `packages/core/src/server.ts`), `project` and `grantId` (MCP requests, `packages/http-app/src/app.ts`), `keyId`
  (pass-through), `traceId` and `spanId` (every MCP request, and its access line, when telemetry is on and the request is
  sampled: random hex ids, P8-90), `component: "nerdgraph"` and `op` (NerdGraph client). Known issue: a field named `ts`, `level` or
  `msg` overwrites the record's own value (P8-75).
- **Redaction (mandatory):** the message goes through `redact()` and every field through `redactValue()` before the line
  is built. `redact()` replaces New Relic keys (`NRAK-`, `NRAA-`, `NRII-`, ... and license keys), `rb_` tokens, `Bearer`
  and other `Authorization` credentials, `name=value` pairs whose name looks like a key, secret, password or token, JWTs,
  AWS, GitHub, Slack, Stripe and OpenAI-style tokens, URL credentials and PEM private keys. Every pattern runs in time
  linear in its input (P8-01). `redactValue()` blanks any object key named like a secret (`apiKey`, `authorization`,
  `token`, `password`, `secret`, `client_secret`, `master_key`, `cookie`, ...), keeps a `Secret`'s `[REDACTED]`
  serialisation, reduces an `Error` to its name and redacted message (no stack), and cuts cycles and depth beyond 8.
  Where a value is also truncated, `redactHead()` redacts only the kept part plus a 1 KiB margin and drops the
  unverified tail, so a secret split by the cut is still recognised and the work stays bounded (P8-01, #249).
- **Access log:** one `http request` line per request (`debug` for `/health`), written by the first middleware of
  `createHttpApp` (`packages/http-app/src/app.ts`): `requestId`, `method`, `route` (the registered route **pattern**, such
  as `/p/:slug/mcp`, or `unmatched`; never the path or query string), `status`, `ms`, plus what the handlers set:
  `project` (slug), `tokenId`, `grantId`, `oauthClient`, `principal` (`token` / `session`), `admin`, `passthrough`,
  `keyId` and `region` (pass-through), `cached`, `deny` (a stable authentication or authorization reason), `reject`
  (`host`, `origin`, `body_size`, `batch`, `tls_required`, `bad_region`, `cross_site` or a rate-limit rule),
  `timeout`, `login` (sign-in outcome), `publicCatalog`, and `mcpMethod` / `mcpName` (from the request body, each
  checked by `safeMcpHeader` in `packages/http-app/src/security.ts`). The `X-Request-Id` response header carries the same
  id, so a user's report can be matched to the line.
- **Other lines:** tool outcome (`tool ok` at `debug`, `tool error` with `ms`, the `RB_*` code and the error's name and
  redacted message), NerdGraph retries and network errors (attempt, code, delay, error class), query-cache and audit
  write failures (error class only), OAuth lifecycle events (`oauth refresh token reused; device revoked`, ...,
  provider grant id only), `credential could not be opened` (credential id), `unhandled error` (error class and request
  id, the caller gets `{"error":"internal_error"}`), boot warnings and errors (the variable's name, never its value),
  purge results.
- **Log injection:** every record is JSON-encoded as a whole, so a value can't start a new line or forge a field. Fields
  that come from a request (`mcpMethod`, `mcpName`, route) are pattern-checked first; the CLI strips control and bidi
  characters from what it prints.
- **Retention, access, deletion:** relic-bridge keeps nothing. On Node the operator's process manager owns stderr
  (journald, `docker logs`; the example `deploy/docker-compose.example.yml` sets no log rotation, so configure one).
  On Workers, [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) keeps logs 3
  days (Free) or 7 days (Paid) and records an **invocation log** per request besides our lines: method, URL and request
  metadata, with only heuristic redaction of credentials documented by Cloudflare. Treat Workers Logs as sensitive,
  limit who in the Cloudflare account can read them, and turn invocation logs off
  (`observability.logs.invocation_logs: false`) if you don't need them.

## Audit log

**Code:** `packages/http-app/src/audit.ts` (`createAuditRecorder`), storage `audit_log` (`packages/storage/src/schema.ts`),
retention in `apps/cli/src/serve.ts` (`purgeAudit`), `apps/cli/src/audit.ts` and `apps/worker/src/worker.ts`
(`purgeAudit`, scheduled handler). User guide: [audit log](../guide/audit-log.md).

**Row:** `id`, `ts` (epoch ms), `kind` (`tool_call`, `auth`, `admin`), `action`, `status` (`ok`, `error`, `denied`),
`request_id`, `user_id`, `grant_id`, `token_id`, `client_id` (OAuth client), `key_id` (pass-through `pt_` fingerprint
id), `project_id`, `account_ids`, `nrql`, `duration_ms`, `inspected_count`, `error_code`, `target_type`, `target_id`,
`details` (JSON).

**Events** (every `action` written in `packages/http-app/src`, `apps/cli/src` and `apps/worker/src`):

| Kind | Actions | Written by | Notes |
|---|---|---|---|
| `tool_call` | the tool name | `hooks.onToolCall`, `onPassthroughToolCall` | Accounts, NRQL per `RB_AUDIT_NRQL`, duration, inspected count, `RB_*` code; write tools add `details.write` (arguments capped at 120 characters per string, depth 8, 20 items; nested NRQL masked; the tool's own record). |
| `tool_call` | `write.intent` | `hooks.onWriteIntent` | Stored and awaited before a write's mutation; a failed append refuses the write (fail closed). |
| `auth` | `auth.denied` | `hooks.onAuthFailure` (MCP, admin API, OAuth bearer) | Stable reason in `error_code` (`missing_token`, `admin_bad_token`, `oauth_invalid`, ...); `details.ip` when `RB_AUDIT_CLIENT_IP` is on. Never the presented value. |
| `auth` | `request.rejected` | `hooks.onRejected` | Rate limits, size, batch, Host and Origin refusals; the caller's ids when authenticated, else `details.ip`. |
| `auth` | `tool.not_granted`, `quota.denied` | `hooks.afterMcp`, `hooks.onQuotaDenied` | `quota.denied` at most once per grant, period and measure per 15 min. |
| `auth` | `login.ok`, `login.denied` | `recorder.login` (`packages/http-app/src/identity.ts`) | Provider, outcome, reason, `identityHash` (keyed, never the email or subject), `previousRole`, `ip`. |
| `auth` / `admin` | `auth.suppressed`, `admin.suppressed` | the per-minute caps | Refusal rows above 120 per minute (per process or isolate) are counted into one summary row (T20). |
| `admin` | `admin.forbidden` | admin API, admin panel, logout | Role, CSRF, fetch-metadata and Origin refusals of a signed-in session; `refusal` rows are capped. |
| `admin` | `user.*`, `credential.*`, `project.*`, `grant.*`, `token.*`, `session.create`, `session.revoke`, `session.revoke_all`, `session.revoke_all_users`, `setup_link.create`, `keys.rotate`, `config.export`, `config.import`, `audit.purge`, `oauth.consent.*`, `oauth.device.replace`, `oauth_device.revoke`, `oauth_client.remove`, `oauth_registration.set`, `oauth.client.refused`, `oauth.token.issue`, `oauth.token.refresh`, `oauth.token.refused`, `oauth.token.reuse`, `oauth.token.replay`, `credential.decrypt_failed`, and the write verbs `change_event.create`, `dashboard.create`, `issue.acknowledge`, `issue.close` | `recorder.admin` from the admin API (`details.via`: `admin_token` or `session`), the panel, the local CLI (`via: cli`, `cliUser`), the OAuth server and the purge jobs | `details` is deep-redacted and capped at 2000 characters (`sanitizeDetails`); never a secret value (a setup link row has the lifetime and provider, never the code). |

**Protection of content:** NRQL is masked by default (`mask`: literals replaced by `?`, then redacted and cut at 2000
characters with `redactHead`); `hash` keeps `sha256:` and 32 hex characters of the masked shape; `full` keeps the
redacted text (warned at boot); `off` stores nothing (`nrqlForAudit`). Client addresses: `RB_AUDIT_CLIENT_IP` (default
on) adds `details.ip` to pre-authentication refusals and sign-in rows only, from the socket or the trusted
`X-Forwarded-For` hops (`RB_TRUSTED_PROXY_HOPS`) on Node and `CF-Connecting-IP` on Workers. Sign-in identities are
stored only as the keyed `identityHash` ([cryptography](cryptography.md#keys-derived-from-the-master-key)).

**Write failures:** every row except `write.intent` is written in the background; a failed append logs
`audit write failed` (kind, action, request id, error class) and never changes the response, so rows are lost during a
database outage.

**Retention and deletion:** `RB_AUDIT_RETENTION_DAYS` (default 90, `0` keeps everything). `serve` purges at start and
every hour (`purgeAudit`, logged as `audit rows purged`, not written as an audit row); the Worker's hourly cron deletes
oldest first in batches of 500, at most 10 000 rows per run, and records `audit.purge` (`source: cron`) when it removed
rows; `relic-bridge audit purge` records `audit.purge`. Deleting a user leaves their ids in old rows until retention
removes them. A `db export` copies the audit log to the Worker unless `--no-audit`.

**Readers:** `GET /api/admin/v1/audit` and `/audit/stats` and the panel (`/admin/audit`, CSV export of at most 5000
rows): owners and admins see every row; members see only rows with their own `user_id` (forced in `listAudit`; asking
for another user's is `403` and an `admin.forbidden` row); the bootstrap admin token sees everything. Locally,
`relic-bridge audit tail` reads the SQLite file. Anyone with the database (the SQLite file, created `0600`, or D1
through the Cloudflare account) can read every row.

**Tamper resistance:** the repository offers only `append`, `list`, `stats` and `purgeBefore`
(`packages/storage/src/types.ts` `AuditLogRepository`): no API or tool updates or deletes a single row. An operator with
database access can still change or delete rows, and there is no hash chain or signature (ASVS V16.4.2, recorded as a
design limit). For an independent copy, ship the stderr log or enable OTLP export.

**`RB_AUDIT=off`** disables every row above (warned at boot); write tools then refuse to start, because they need the
write intent (`RB_WRITE_TOOLS` requires `RB_AUDIT=on`).

## OTLP export

**Code:** `packages/http-app/src/telemetry.ts` (`createTelemetry`), guide [observability](../guide/observability.md).
Off unless `RB_OTEL=on`.

| Signal | What is exported | Attributes (each value pattern-checked, else `other`) |
|---|---|---|
| Resource | once per exporter | `service.name`, `service.version`, `service.instance.id` (random, never from host or request data), `telemetry.sdk.*`, `process.runtime.name` |
| Metrics | tool calls, durations, NerdGraph calls and response bytes, rejected requests, `rpc.server.duration` | tool name, `ok` / `error`, `RB_*` code and fault class, project slug (token mode), mode (`token`, `passthrough`, `stdio`), refusal reason, HTTP status |
| Traces | one span per MCP request (sampled by `RB_OTEL_SAMPLE`): `tools/call <tool>` for a tool call, the method name (`initialize`, `tools/list`, `prompts/get`, `resources/read`, `tasks/*`, ...) for every other request (P8-90) | as metrics, plus MCP and `gen_ai` semantic attributes, `error.type` (an `RB_*` code, or the HTTP status for a method span), `http.response.status_code` (method spans), and for write tools `write.applied`, `write.confirmation` and `elicitation.result` (fixed words); a caller's `traceparent` only with `RB_OTEL_TRACEPARENT=on`. Never a prompt name, a resource URI or an argument |
| Logs | the structured log at `info` and above, after redaction | message only when it looks like a fixed phrase (`LOG_MESSAGE`, no NRQL words or long opaque runs), else `other`; only the fields in `LOG_FIELDS`: `tool`, `code`, `errorCode`, `status`, `method`, `route`, `mcpMethod`, `mcpName` (tool name with `tools/call` only), `error` (class), `path` (route paths only), `reason`, `ms`, `removed`. Everything else is dropped. Each record also carries the OTLP `traceId` and `spanId` of the request's span when it was sampled (P8-90): 32 and 16 lowercase hex characters, checked before export, never attributes. |

**Never exported:** NRQL text (not even masked), tool arguments, results, account ids, user, grant, token and OAuth
client ids, emails, IP addresses, keys, tokens, the master key, the endpoint and its headers. **Destination trust:** the
endpoint must be https (http only for localhost) without credentials in the URL (`parseOtlpEndpoint`); its headers
(`RB_OTEL_HEADERS`, typically a New Relic license key) are a secret on Workers and never logged. A failing collector
pauses exports for 30 s and never affects a response. Whoever reads the collector sees tool names, project slugs,
timing and volume (THREAT_MODEL T30).

## Events ASVS V16 asks for

| Event (ASVS 5.0) | Sink | Status | Gap |
|---|---|---|---|
| Authentication success: device token, OAuth bearer, admin token (V16.3.1) | stderr access line (`tokenId`, `grantId`, `oauthClient`, `principal`); audit `tool_call` and `admin` rows carry the actor | covered | — |
| Authentication success: admin sign-in (V16.3.1) | audit `login.ok`, `session.create` | covered | — |
| Authentication failure: tokens, admin token, OAuth bearer, sign-in (V16.3.1) | audit `auth.denied`, `login.denied`; stderr `deny` | covered | — |
| Logout and session revocation (V16.3.1) | audit `session.revoke`, `session.revoke_all` | covered | Expiry is not a row of its own, by decision (below) |
| Session expiry, idle or absolute (V16.3.1) | audit `auth.denied` with `error_code` `session_idle` or `session_expired`, when the lapsed cookie is next presented | covered | No `session.expired` row, by decision (below) |
| OAuth token issuance (code exchange, refresh) (V16.3.1) | audit `oauth.token.issue` (code exchange) and `oauth.token.refresh`: user, grant, OAuth client, `oauth_<provider grant id>`, project; failures and reuse as `oauth.token.refused`, `oauth.token.reuse` | covered | Success rows are capped per minute (T20); never a token, code or hash |
| Access-control refusals (V16.3.2) | audit `admin.forbidden`, `tool.not_granted`, `quota.denied`, `request.rejected`; stderr `deny` | covered | — |
| Admin and configuration changes (V16.3.3) | audit `admin` rows, `details.via` | covered | — |
| Bypass attempts: rate limits, size, Host, Origin, CSRF, fetch metadata (V16.3.3) | audit `request.rejected`, `admin.forbidden`; stderr `reject` | covered | — |
| Input validation refusals (V16.3.3) | admin API: audit row (`invalid_request`, capped, no values); tools: `tool_call` row with `RB_INPUT_INVALID`; oversized or batch MCP bodies: `request.rejected` and stderr `reject` | covered | — |
| Secret use failures: undecryptable credential (V16.3.4) | audit `credential.decrypt_failed` (`status` `error`, `error_code` = the crypto reason such as `decrypt_failed` or `key_version_unknown`, credential id, project, key version; capped) and stderr `credential could not be opened` | covered | — |
| Secret use failures: wrong or retired master key, bad admin token or fingerprint secret at boot (V16.3.4) | stderr boot error naming the variable; the Worker answers 503 | covered | — |
| Unexpected errors (V16.3.4) | stderr `unhandled error`, `admin api error`, `login failed` | covered | — |
| Audit failures (V16.3.4) | stderr `audit write failed`; write intents fail closed | covered | — |
| Log retention changes (V16.4) | audit `audit.purge` (`details.source`: `cli`, `cron` or `schedule`, the hourly purge of `serve`) with the number of rows removed, when any were | covered | — |

### Session expiry: decision (P8-85)

No `session.expired` row. A session lapses by the clock; no code runs at that moment, so a row could only be written when
someone next presents the old cookie, and that request already writes `auth.denied` with `error_code` `session_idle` or
`session_expired` (capped like every refusal, throttled by the failed-credential limiter). A second row per stale cookie
would add volume on an unauthenticated path (T20) and no information: the sign-in (`login.ok`, `session.create`) and the
fixed timeouts give the expiry time. Pinned by `packages/http-app/test/authz/session-expiry-audit.test.ts`.

### Volume of the new rows (T20)

`oauth.token.issue`, `oauth.token.refresh` and `credential.decrypt_failed` are written with `capped: true`: their own
per-minute cap (the same size as the `auth` refusal cap, default 120), separate from the refusal cap so a flood of
refusals cannot hide them, with one `admin.suppressed` summary row (`details.rows: "capped"`) for what was dropped.
Issuance rows need a valid code or refresh token and pass the token endpoint's rate limits first. No new
unauthenticated path writes a row.

## What is never logged

Secrets and credentials (New Relic keys, `rb_` tokens, OAuth tokens and codes, session secrets and CSRF tokens, setup
codes, the master key, the admin token, IdP client secrets, OTLP headers), query result data, request bodies other than
a write tool's capped arguments, emails and IdP subjects in audit rows (only `identityHash`), and the request path or
query string in our own log lines. Enforced by the redacting logger and recorder, and checked by tests:
`packages/core/test/logger.test.ts` ("redacts secrets in messages, fields, Secrets and errors"),
`packages/core/test/redact.test.ts`, `packages/http-app/test/app.test.ts` ("logs one redacted line per request,
without the token"), `packages/http-app/test/audit.test.ts` (failed authentication "never the token", NRQL cut and
redaction, `sanitizeDetails`), `packages/http-app/test/telemetry.test.ts` ("exports only allowlisted, pattern-checked
fields; secrets and free text never leave"), `apps/worker/test/worker.test.ts` (admin token refused or warned "without
logging it").

## Related

[Audit log guide](../guide/audit-log.md), [observability guide](../guide/observability.md),
[self-hosting](../guide/self-hosting.md), [cryptographic inventory](cryptography.md), [THREAT_MODEL](../THREAT_MODEL.md)
T8, T17, T20, T28, T30, [ASVS checklist](asvs-l2.md) V16.
