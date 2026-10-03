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
| `action` | The tool name (`run_nrql`), or `auth.denied`, `request.rejected`, `tool.not_granted`, `auth.suppressed`, or an admin verb such as `token.create`. |
| `status` | `ok`, `error` (the tool failed) or `denied`. |
| `request_id` | Matches the `requestId` in the server log. |
| `user_id`, `grant_id`, `token_id`, `project_id` | Who, by id. Labels and names live on those records; the project's slug is also kept in `details` so the row stays readable after a deletion. |
| `account_ids` | The New Relic accounts the query ran against. |
| `nrql` | The query, **as configured below** (default: literal values masked). |
| `duration_ms`, `inspected_count` | How long it took and how many events New Relic inspected. |
| `error_code` | The stable `RB_*` code for a failed tool, or the reason for a refusal (`missing_token`, `rate_limit_token`, `tool_not_granted`, ...). |
| `target_type`, `target_id`, `details` | For admin actions: what was changed. `details` holds small non-secret facts only. |

**Never stored**: access tokens (not even a prefix of a presented token), New Relic keys, the master key, request
bodies, or any result rows. Everything written passes through the same redaction as the logs, and a test scans the
audit rows for secrets.

Failed authentication and rate-limit rows (`kind = auth`) also carry the client address in `details.ip`, because there
is nothing else to identify a stranger by. Turn that off with `RB_AUDIT_CLIENT_IP=off`.

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

Through the [admin API](../reference/admin-api.md#audit): `GET /api/admin/v1/audit`, newest first, filtered by `kind`,
`action`, `status`, `projectId`, `userId`, `grantId`, `tokenId`, `since` / `until` (epoch ms or ISO 8601), paged with
`limit` and `cursor`:

```sh
curl -s -H "Authorization: Bearer $RB_ADMIN_TOKEN" \
  'http://127.0.0.1:8787/api/admin/v1/audit?kind=auth&since=2026-10-01T00:00:00Z&limit=100'
```

Admin changes made through the API carry `details.via = "admin_token"` (no user identity until Phase 4 sign-in);
failed attempts are recorded too, with `status` `error` (or `denied`) and the API error code.

## Retention

`RB_AUDIT_RETENTION_DAYS` (default `90`; `0` keeps everything). `serve` deletes older rows at startup and every hour.
To do it by hand or from cron:

```sh
relic-bridge audit purge                       # uses RB_AUDIT_RETENTION_DAYS (default 90)
relic-bridge audit purge --older-than-days 30
```

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
