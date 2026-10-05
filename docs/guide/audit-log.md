# Audit log

`relic-bridge serve` records who used the server and what they asked for, so you can answer "which device ran that
query?" or "who created that token?" later. It is **on by default**, stored in the same SQLite file as everything else
(table `audit_log`, append-only: the server only inserts and, for retention, deletes old rows).

## What is stored

One row per event, with these fields (empty when they don't apply):

| Field | Meaning |
|---|---|
| `ts` | When, epoch milliseconds. |
| `kind` | `tool_call`, `auth` (a refused request) or `admin` (a change to credentials, projects, grants, tokens). |
| `action` | The tool name (`run_nrql`), or `auth.denied`, `request.rejected`, `tool.not_granted`, `auth.suppressed`, `admin.suppressed`, or an admin verb such as `token.create`. |
| `status` | `ok`, `error` (the tool failed) or `denied`. |
| `request_id` | Matches the `requestId` in the server log. |
| `user_id`, `grant_id`, `token_id`, `project_id` | Who, by id. Labels and names live on those records; the project's slug is also kept in `details` so the row stays readable after a deletion. |
| `key_id` | Pass-through calls only (see below): `pt_` + 12 hex characters of the key's fingerprint, instead of a user, grant and token. Never the key. |
| `account_ids` | The New Relic accounts the query ran against. |
| `nrql` | The query, **as configured below** (default: literal values masked). |
| `duration_ms`, `inspected_count` | How long it took and how many events New Relic inspected. |
| `error_code` | The stable `RB_*` code for a failed tool, or the reason for a refusal (`missing_token`, `rate_limit_token`, `tool_not_granted`, ...). |
| `target_type`, `target_id`, `details` | For admin actions: what was changed. `details` holds small non-secret facts only. |

**Never stored**: access tokens (not even a prefix of a presented token), New Relic keys, the master key, request
bodies, or any result rows. Everything written passes through the same redaction as the logs, and a test scans the
audit rows for secrets.

Rows for requests that failed **before** a token was accepted (`auth.denied`, and `request.rejected` for the per-IP
limits) also carry the client address in `details.ip`, because there is nothing else to identify a stranger by. Turn
that off with `RB_AUDIT_CLIENT_IP=off`. A `request.rejected` row for an authenticated caller (a per-token or per-grant
rate limit) or for a pass-through key names the user, grant, token or `key_id` instead and has no `details.ip`; its
`details` is `{"status": 429}`.

## Sign-in rows

Every sign-in attempt that reached a provider writes one `auth` row: `login.ok` (with the user's id) or `login.denied`
(with the reason in `error_code`: `not_allowed`, `not_provisioned`, `identity_conflict`, `user_disabled`, or a protocol
reason such as `unknown_state`, `invalid_token` or `email_unverified`). `target_id` is the provider id. `details` holds:

| Key | Meaning |
|---|---|
| `idp` | The provider kind (`google`, `github`, `cf-access`, `oidc:<name>`). |
| `outcome` | `login.ok` only: `existing`, `linked` (first sign-in bound the account), `provisioned` or `owner_bootstrap`. |
| `identityHash` | Once the provider verified an identity: `v<N>.` and 22 characters, a keyed hash (HMAC-SHA-256 under a key derived from master key version `N`) of the provider and subject. The same identity gives the same value, so repeated `identity_conflict` or `not_allowed` attempts by one person can be grouped; without the master key it cannot be matched to a guessed email or subject. Never the email or the subject itself. Rotating the master key changes every value. |
| `previousRole` | `owner_bootstrap` of an existing user: the role the setup link replaced. |
| `ip` | The client address, as for other refusals (`RB_AUDIT_CLIENT_IP`). |

Group refusals by identity with `relic-bridge audit tail --action login.denied --json` and the `identityHash` field.

## Pass-through calls

When [pass-through mode](self-hosting.md#pass-through-mode) is on, each `tools/call` on `/passthrough/mcp` writes one
`tool_call` row like any other (tool, accounts, outcome, error code, duration, NRQL as configured below). There is no
user, grant, token or project, so the actor is `key_id`, and `details` holds `{"mode": "passthrough", "region": "US"}`.
Refusals on that route (`request.rejected` for a rate limit) carry `key_id` too.

`key_id` comes from a keyed HMAC-SHA-256 of the region and the key, so it can't be reversed or checked against a guessed
key without the server's secret, and the key itself is never stored. By default that secret is random per process, so
the same key gets a **new** `key_id` after every restart; rows from before and after a restart can't be linked. (The
library option `passthrough.fingerprintSecret` pins it; `serve` doesn't expose it.) Use it to see "this key did this",
not as a durable identity.

```sh
relic-bridge audit tail --key-id any            # every pass-through row
relic-bridge audit tail --key-id pt_0123456789ab
```

## NRQL privacy: `RB_AUDIT_NRQL`

| Value | What the `nrql` column holds |
|---|---|
| `mask` (default) | The query with quoted strings and numbers replaced by `?`, keeping keywords, event types, attribute names and the time window and `LIMIT`: `SELECT count(*) FROM Log WHERE message = ? SINCE 1 hour ago`. |
| `hash` | `sha256:` and 32 hex characters of the masked query: identical shapes group together, the text is not stored. |
| `full` | The query text, redacted for secret patterns only (literal values stay; warned at start). |
| `off` | Nothing. |

Masking is a best-effort tokenizer-free scan, aimed at keeping values (customer ids, emails, error text) out of the
log, not at being a security boundary: attribute names in the query are kept, and an unusual query can leak a fragment.
If the query text is itself sensitive, use `hash` or `off`. Stored text is truncated at 2000 characters.

## Reading it

Through the [admin API](../reference/admin-api.md#audit) (or the panel, below): `GET /api/admin/v1/audit`, newest first, filtered by `kind`,
`action`, `status`, `projectId`, `userId`, `grantId`, `tokenId`, `keyId` (a `pt_…` id, or `any` for every pass-through row), `since` / `until` (epoch ms or ISO 8601), paged with
`limit` and `cursor`:

```sh
curl -s -H "Authorization: Bearer $RB_ADMIN_TOKEN" \
  'http://127.0.0.1:8787/api/admin/v1/audit?kind=auth&since=2026-10-01T00:00:00Z&limit=100'
```

A change request the API refuses as invalid (schema or malformed JSON) is recorded too (`status` `error`, `error_code` `invalid_request`, no submitted values); these rows are capped per minute like `auth` rows, with an `admin.suppressed` summary. Admin changes made through the API carry `details.via`: `"admin_token"` for the bootstrap token (no user identity) or `"session"` for a signed-in user, whose id is the row's `user_id`; local CLI changes carry `"cli"`;
failed attempts are recorded too, with `status` `error` (or `denied`) and the API error code.

### In the admin panel

Signed-in admins and owners read the log at **Audit** (`/admin/audit`) and see usage numbers at **Usage**
(`/admin/usage`); see [the admin panel](admin-panel.md). Members see only their own rows (the admin API forces
`userId` to theirs: asking for someone else's is `403 forbidden` and an `admin.forbidden` row). Audit text can contain
what a caller sent (a tool name, an error message), so the panel shows it as plain text and the CSV export quotes every
text cell and prefixes `'` to any that starts with `=`, `+`, `-`, `@`, a tab or a carriage return.

### Usage statistics

`GET /api/admin/v1/audit/stats` (admins and owners) aggregates `tool_call` rows in one SQL statement per request:
calls, errors, denied, summed and longest duration, inspected events, grouped by `groupBy` = `action` (the tool,
default), `project`, `grant`, `token` or `day` (UTC), optionally narrowed by `action`, `projectId`, `userId`,
`grantId`, `tokenId`. The window is `[since, until)`, at most 90 days (default the last 7); at most 100 groups come
back (`limit`, default 50). `GET /audit?order=slowest` lists the rows with the longest durations. Cost: the aggregate
reads every `tool_call` row in the window, using the timestamp index. That is cheap on SQLite; on D1 each row read
counts against the plan's row-read allowance, so keep dashboards on short windows if you record very many calls.

## Retention

`RB_AUDIT_RETENTION_DAYS` (default `90`; `0` keeps everything). `serve` deletes older rows at startup and every hour.
To do it by hand or from cron:

```sh
relic-bridge audit purge                       # uses RB_AUDIT_RETENTION_DAYS (default 90)
relic-bridge audit purge --older-than-days 30
```

On Cloudflare Workers an hourly cron trigger (`triggers.crons` in `wrangler.jsonc`) does the same with the same
`RB_AUDIT_RETENTION_DAYS`. It deletes oldest rows first in batches of 500, at most 20 batches (10,000 rows) per run, and
the next run continues; a failure is logged as `audit purge failed` and never affects requests. It is recorded as
`audit.purge` with `source: cron` when it removed rows. Delete the trigger (or set the retention to `0`) to keep history.

The purge is itself recorded (`admin` / `audit.purge`, with the number of rows removed). `RB_AUDIT=off` turns recording
off entirely (warned at start).

## Behaviour you can rely on

- **A failed audit write never fails or slows a request.** Rows are written after the response is sent; if the write
  fails, the server logs `audit write failed` (kind, action, request id and error name only) and carries on. During a
  database outage the audit rows for that period are lost, and the server also answers `503` for requests that need the
  database to authenticate.
- **Floods can't fill the table.** Refusal rows are capped at 120 per minute; beyond that they are counted into one
  `auth.suppressed` row for the minute.
- A tool call that the grant doesn't include is recorded as `tool.not_granted`, from both 2025- and 2026-era clients
  (the tool name is read from the request body, not from the `Mcp-Name` header).
- `tools/list` and other protocol traffic is not audited; only tool calls, refusals and admin changes.
- The log records that a query ran, not that it was *allowed to see* particular rows: results are never examined.

## For developers: recording admin actions

`createAuditRecorder({ storage, ... })` (in `@relic-bridge/http-app`) returns `{ hooks, admin(event), purge(days) }`.
Compose `hooks` with the rate-limit hooks through `mergeHooks`. The admin REST API and CLI call `admin` for every
change:

```ts
await audit.admin({
  actor: { userId, tokenId, requestId },   // whatever is known about the caller
  action: 'token.create',                  // dotted verb: credential.create, grant.update, token.revoke, ...
  targetType: 'token',
  targetId: token.id,
  projectId,
  details: { label: 'phone', ttlDays: 30 }, // never secret values; redacted and size-bounded anyway
});
```

`admin` resolves when the write finished and never rejects. On Workers pass the promise to `waitUntil`.
