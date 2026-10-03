<!-- GENERATED from the admin API OpenAPI document by packages/http-app/test/admin-docs.test.ts — do not edit. -->
<!-- Regenerate: pnpm docs:admin-api -->

# Admin API reference

API-first management of a relic-bridge instance: users, New Relic credentials, projects, grants, device tokens and the audit log. Authenticate with the bootstrap admin token (`Authorization: Bearer …`). New Relic keys are accepted in request bodies only and never returned; token hashes are never returned.

Base path: `/api/admin/v1`. OpenAPI 3.1 document: `GET /api/admin/v1/openapi.json` (admin token required).
Guide: [self-hosting](../guide/self-hosting.md#admin-api).

## Conventions

- **Authentication**: `Authorization: Bearer <RB_ADMIN_TOKEN>` on every request. Cookies and query-string
  credentials are never accepted; every failure is the same `401` (and counts toward the per-IP failure throttle).
- **Bodies**: `application/json` only (`415` otherwise; body-less actions such as `…/revoke` need no `Content-Type`), at most 64 KiB (`413`). Unknown fields are refused (`400`).
- **Errors**: `{ "error": { "code", "message", "field"?, "detail"? } }`. Messages name fields and ids only: a 404 or an unknown-field message echoes the id or field name, redacted and truncated (64 and 100 characters), never a submitted value.
- **Lists**: `?limit=` (1-200, default 50) and `?cursor=`; responses are `{ "data": [...], "nextCursor" }`.
- **Times**: epoch milliseconds.
- Every endpoint can also answer `400`, `401`, `429` and `503` (storage unavailable or locked, with `Retry-After`); the tables below list the other answers.
- **Secrets**: New Relic keys are accepted in request bodies only and never returned (credentials come back as
  masked metadata); token hashes are never returned; a new token appears once, in the `POST /tokens` response.
- **Audit**: every change writes an `admin` audit row (actor `admin_token`), including failed attempts.

## Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Unknown field, wrong type, a rule broken (`field` names it) |
| `unauthorized` | 401 | Missing or wrong admin token |
| `not_found` | 404 | No such resource (or no such endpoint) |
| `conflict` | 409 | Duplicate slug or email, a credential still in use, a concurrent change |
| `read_only` | 409 | The storage is read-only |
| `payload_too_large` | 413 | Body over the limit |
| `unsupported_media_type` | 415 | Body is not JSON |
| `not_permitted` | 422 | A rule refused it (e.g. a grant using another user's personal key) |
| `key_rejected` | 422 | New Relic refused the key, or it is not a User key (`detail`: `RB_AUTH_*`) |
| `rate_limited` | 429 | Too many requests or failed attempts from this address (`Retry-After`) |
| `upstream_unavailable` | 502 | New Relic could not be asked; nothing was changed (`detail`: `RB_*`) |
| `unavailable` | 503 | Storage or encryption unavailable |
| `internal_error` | 500 | Unexpected; see the server log by `X-Request-Id` |

## Users

### GET /users

List users

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `UserPage` | Users |

### POST /users

Create a user

Users own personal credentials and receive user grants. Login identities arrive in Phase 4.

Request body (`CreateUser`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | `string` | yes |  |
| `displayName` | `string \| null` | no |  |
| `role` | `"owner" \| "admin" \| "member"` | no | Default `member`. |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `UserResponse` | Created |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### GET /users/{id}

Get a user

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `UserResponse` | The user |
| 404 | `Error` | No such resource (`not_found`) |

### PATCH /users/{id}

Update or disable a user

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

Request body (`UpdateUser`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `displayName` | `string \| null` | no |  |
| `role` | `"owner" \| "admin" \| "member"` | no |  |
| `disabled` | `boolean` | no | true disables the user: every grant of theirs and every key they own stops. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `UserResponse` | Updated |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

## Credentials

### GET /credentials

List credentials (masked)

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |
| `ownerUserId` | query | `string` | no | Only keys this user owns. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `CredentialPage` | Credentials, without key material |

### POST /credentials

Add a New Relic User key

Validates the key against NerdGraph (`actor.user`, `actor.accounts`) and stores it encrypted. A key New Relic refuses is not stored. The key is never returned.

Request body (`CreateCredential`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | `string` | yes |  |
| `region` | `"US" \| "EU" \| "JP"` | yes |  |
| `apiKey` | `string` | yes | New Relic User API key (`NRAK-…`). Accepted in the request body only; never returned. |
| `ownerUserId` | `string \| null` | no | User who owns this key (their personal key); omit for a shared key. |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `CredentialResponse` | Created (masked) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |
| 422 | `Error` | Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`) |
| 502 | `Error` | New Relic could not be asked (`upstream_unavailable`) |

### GET /credentials/{id}

Get a credential (masked)

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `CredentialResponse` | The credential, without key material |
| 404 | `Error` | No such resource (`not_found`) |

### PATCH /credentials/{id}

Rename a credential

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

Request body (`UpdateCredential`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `CredentialResponse` | Updated |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### DELETE /credentials/{id}

Delete a credential

Refused (`409`) while a project or grant uses it.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 204 | — | Deleted |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |

### POST /credentials/{id}/rotate

Replace the key

Validates the new key, re-encrypts it under the current master key and swaps it in (compare-and-swap). Warns `nr_user_changed` when the new key belongs to another New Relic user.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

Request body (`RotateCredential`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | yes | New Relic User API key (`NRAK-…`). Accepted in the request body only; never returned. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `CredentialResponse` | Rotated (masked) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |
| 422 | `Error` | Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`) |
| 502 | `Error` | New Relic could not be asked (`upstream_unavailable`) |

### POST /credentials/{id}/revalidate

Re-check the key against New Relic

A refused key is marked `invalid` (every grant using it fails closed); a valid key gets its reachable accounts refreshed; network trouble changes nothing (`outcome: error`).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `RevalidationResponse` | Outcome |
| 404 | `Error` | No such resource (`not_found`) |

## Projects

### GET /projects

List projects

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |
| `slug` | query | `string` | no | URL slug: `/p/{slug}/mcp`. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `ProjectPage` | Projects |

### POST /projects

Create a project

Request body (`CreateProject`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | `string` | yes | URL slug: `/p/{slug}/mcp`. |
| `name` | `string \| null` | no |  |
| `defaultAccountId` | `integer` | yes |  |
| `allowedAccountIds` | `integer[]` | yes |  |
| `enabledTools` | `string[] \| null` | no | Upper limit of tools; null = all. |
| `limits` | `Limits` | no | Query limits; absent fields fall back to the defaults. |
| `defaultCredentialId` | `string \| null` | no | Credential used by grants that name none. |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `ProjectResponse` | Created |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### GET /projects/{id}

Get a project

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `ProjectResponse` | The project |
| 404 | `Error` | No such resource (`not_found`) |

### PATCH /projects/{id}

Update, disable or enable a project

Narrowing a project narrows every grant on it at once (access is the intersection).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

Request body (`UpdateProject`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | `string` | no | URL slug: `/p/{slug}/mcp`. |
| `name` | `string \| null` | no |  |
| `defaultAccountId` | `integer` | no |  |
| `allowedAccountIds` | `integer[]` | no |  |
| `enabledTools` | `string[] \| null` | no |  |
| `limits` | `object` | no |  |
| `defaultCredentialId` | `string \| null` | no | Credential used by grants that name none. |
| `disabled` | `boolean` | no | true refuses every request to the project. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `ProjectResponse` | Updated |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### DELETE /projects/{id}

Delete a project with its grants and tokens

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 204 | — | Deleted |
| 404 | `Error` | No such resource (`not_found`) |

## Grants

### GET /grants

List grants

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |
| `projectId` | query | `string` | no | Only this project. |
| `userId` | query | `string` | no | Only this user. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `GrantPage` | Grants |

### POST /grants

Create a grant

A grant may use the project default credential, a shared one, or its own user’s. Parts the project does not allow are stored but have no effect (listed in `warnings`).

Request body (`CreateGrant`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | `string` | yes | Project the grant is for. |
| `userId` | `string \| null` | no | User the grant is for; omit for a service grant (then `label` is required). |
| `label` | `string \| null` | no |  |
| `credentialId` | `string \| null` | no | Key to use; null = the project's default. |
| `tools` | `string[] \| null` | no | Tool allowlist; null = all the project enables. |
| `accountIds` | `integer[] \| null` | no |  |
| `limits` | `Limits` | no | Query limits; absent fields fall back to the defaults. |
| `rateLimit` | `RateLimit` | no |  |
| `expiresAt` | `integer \| null` | no | Epoch ms, in the future. |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `GrantResponse` | Created |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |
| 422 | `Error` | Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`) |

### GET /grants/{id}

Get a grant

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `GrantResponse` | The grant |
| 404 | `Error` | No such resource (`not_found`) |

### DELETE /grants/{id}

Delete a grant with its tokens

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 204 | — | Deleted |
| 404 | `Error` | No such resource (`not_found`) |

### POST /grants/{id}/revoke

Revoke a grant (all its tokens stop working)

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `GrantResponse` | Revoked |
| 404 | `Error` | No such resource (`not_found`) |

## Tokens

### GET /tokens

List access tokens

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |
| `grantId` | query | `string` | no | Only this grant. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AccessTokenPage` | Tokens, without hashes |

### POST /tokens

Issue a device token

The response carries the token once. Only its hash is stored; it cannot be shown again.

Request body (`CreateToken`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `grantId` | `string` | yes | Grant the token authenticates. |
| `label` | `string` | yes | Device name (`laptop`, `work-pc`). |
| `ttlSeconds` | `integer \| "never"` | no | Lifetime in seconds (default 90 days), or `'never'` (warned). |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `AccessTokenCreated` | Issued |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### GET /tokens/{id}

Get an access token

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AccessTokenResponse` | The token, without its hash |
| 404 | `Error` | No such resource (`not_found`) |

### POST /tokens/{id}/revoke

Revoke an access token

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AccessTokenResponse` | Revoked |
| 404 | `Error` | No such resource (`not_found`) |

## Keys

### POST /keys/rotate

Re-encrypt stored keys under the current master key (one batch)

Master-key rotation for hosts without local database access (a Worker on D1). Start the server with the new key as `RB_MASTER_KEY` and the old one as `RB_MASTER_KEY_PREVIOUS`, then call this until `nextCursor` is `null` (`relic-bridge keys rotate --remote` does). Each row is re-encrypted with a compare-and-swap, so every row stays readable, an interrupted run resumes, and a repeated run changes nothing. A wrong or retired master key answers `503 unavailable` (`detail`: `key_mismatch`, `key_version_retired`) before any row is touched. The previous key can be removed once `pending` is 0. Never returns key material.

Request body (`RotateKeys`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `batchSize` | `integer` | no | Rows to re-encrypt in this call, 1-100 (default 25). |
| `after` | `string \| null` | no | `nextCursor` of the previous call; omit to start from the first row. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `KeyRotationResponse` | What this batch did |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

## Audit

### GET /audit

Query the audit log (newest first)

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `kind` | query | `"tool_call" \| "admin" \| "auth"` | no |  |
| `action` | query | `string` | no | Exact action: a tool name or `token.create`, `auth.denied`, …. |
| `status` | query | `"ok" \| "error" \| "denied"` | no |  |
| `projectId` | query | `string` | no | Only this project. |
| `userId` | query | `string` | no | Only this user. |
| `grantId` | query | `string` | no | Only this grant. |
| `tokenId` | query | `string` | no | Only this access token. |
| `keyId` | query | `string` | no | Pass-through rows: one key fingerprint id (`pt_…`), or `any` for all pass-through rows. |
| `since` | query | `string` | no | Inclusive lower bound: epoch ms or an ISO 8601 date-time. |
| `until` | query | `string` | no | Exclusive upper bound: epoch ms or an ISO 8601 date-time. |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AuditPage` | Audit rows |

## Schemas

### AccessToken

Token metadata. The token hash is never returned.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes |  |
| `grantId` | `string` | yes |  |
| `prefix` | `string` | yes | First characters (`rb_live_Ab3d`), for recognition only. |
| `label` | `string` | yes |  |
| `createdAt` | `integer` | yes | Created (epoch ms) |
| `expiresAt` | `integer \| null` | yes | Expires (epoch ms, null = none) |
| `lastUsedAt` | `integer \| null` | yes | Last used (updated at most every 5 min) (epoch ms, null = none) |
| `revokedAt` | `integer \| null` | yes | Revoked (epoch ms, null = none) |

### AccessTokenCreated

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `AccessToken` | yes | Token metadata. The token hash is never returned. |
| `token` | `string` | yes | The token. Shown once: it is not stored and cannot be recovered. |
| `warnings` | `string[]` | yes | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### AccessTokenPage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `AccessToken[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### AccessTokenResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `AccessToken` | yes | Token metadata. The token hash is never returned. |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### AuditEntry

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `integer` | yes |  |
| `ts` | `integer` | yes | When (epoch ms) |
| `kind` | `"tool_call" \| "admin" \| "auth"` | yes |  |
| `action` | `string` | yes |  |
| `status` | `"ok" \| "error" \| "denied"` | yes |  |
| `requestId` | `string \| null` | yes |  |
| `userId` | `string \| null` | yes |  |
| `grantId` | `string \| null` | yes |  |
| `tokenId` | `string \| null` | yes |  |
| `clientId` | `string \| null` | yes |  |
| `keyId` | `string \| null` | yes | Pass-through key fingerprint id (`pt_…`); never the key. |
| `projectId` | `string \| null` | yes |  |
| `accountIds` | `integer[] \| null` | yes |  |
| `nrql` | `string \| null` | yes | Masked, hashed or full NRQL (RB_AUDIT_NRQL). |
| `durationMs` | `integer \| null` | yes |  |
| `inspectedCount` | `integer \| null` | yes |  |
| `errorCode` | `string \| null` | yes |  |
| `targetType` | `string \| null` | yes |  |
| `targetId` | `string \| null` | yes |  |
| `details` | `object \| null` | yes |  |

### AuditPage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `AuditEntry[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### CreateCredential

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | `string` | yes |  |
| `region` | `"US" \| "EU" \| "JP"` | yes |  |
| `apiKey` | `string` | yes | New Relic User API key (`NRAK-…`). Accepted in the request body only; never returned. |
| `ownerUserId` | `string \| null` | no | User who owns this key (their personal key); omit for a shared key. |

### CreateGrant

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | `string` | yes | Project the grant is for. |
| `userId` | `string \| null` | no | User the grant is for; omit for a service grant (then `label` is required). |
| `label` | `string \| null` | no |  |
| `credentialId` | `string \| null` | no | Key to use; null = the project's default. |
| `tools` | `string[] \| null` | no | Tool allowlist; null = all the project enables. |
| `accountIds` | `integer[] \| null` | no |  |
| `limits` | `Limits` | no | Query limits; absent fields fall back to the defaults. |
| `rateLimit` | `RateLimit` | no |  |
| `expiresAt` | `integer \| null` | no | Epoch ms, in the future. |

### CreateProject

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | `string` | yes | URL slug: `/p/{slug}/mcp`. |
| `name` | `string \| null` | no |  |
| `defaultAccountId` | `integer` | yes |  |
| `allowedAccountIds` | `integer[]` | yes |  |
| `enabledTools` | `string[] \| null` | no | Upper limit of tools; null = all. |
| `limits` | `Limits` | no | Query limits; absent fields fall back to the defaults. |
| `defaultCredentialId` | `string \| null` | no | Credential used by grants that name none. |

### CreateToken

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `grantId` | `string` | yes | Grant the token authenticates. |
| `label` | `string` | yes | Device name (`laptop`, `work-pc`). |
| `ttlSeconds` | `integer \| "never"` | no | Lifetime in seconds (default 90 days), or `'never'` (warned). |

### CreateUser

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | `string` | yes |  |
| `displayName` | `string \| null` | no |  |
| `role` | `"owner" \| "admin" \| "member"` | no | Default `member`. |

### Credential

Masked credential metadata. Key plaintext and ciphertext are never returned.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes |  |
| `label` | `string` | yes |  |
| `region` | `"US" \| "EU" \| "JP"` | yes |  |
| `ownerUserId` | `string \| null` | yes |  |
| `keyHint` | `string \| null` | yes | Last 4 characters of the key, for recognition only. |
| `keyStorage` | `"encrypted" \| "env" \| "inline"` | yes | Where the key lives. The key itself is never returned. |
| `keyVersion` | `integer \| null` | yes | Master key version it is encrypted under. |
| `validationStatus` | `"unvalidated" \| "valid" \| "invalid"` | yes |  |
| `validationErrorCode` | `string \| null` | yes |  |
| `validatedAt` | `integer \| null` | yes | Last validation (epoch ms, null = none) |
| `nrUserId` | `integer \| null` | yes |  |
| `nrUserEmail` | `string \| null` | yes |  |
| `reachableAccountIds` | `integer[] \| null` | yes |  |
| `createdAt` | `integer` | yes | Created (epoch ms) |
| `updatedAt` | `integer` | yes | Last change (epoch ms) |
| `revokedAt` | `integer \| null` | yes | Revoked (epoch ms, null = none) |

### CredentialPage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Credential[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### CredentialResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Credential` | yes | Masked credential metadata. Key plaintext and ciphertext are never returned. |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### Error

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `error` | `object` | yes |  |

### Grant

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes |  |
| `projectId` | `string` | yes |  |
| `userId` | `string \| null` | yes | null for a service grant. |
| `label` | `string \| null` | yes |  |
| `credentialId` | `string \| null` | yes | null = the project's default credential. |
| `tools` | `string[] \| null` | yes |  |
| `accountIds` | `integer[] \| null` | yes |  |
| `limits` | `Limits` | yes | Query limits; absent fields fall back to the defaults. |
| `rateLimit` | `RateLimit` | yes |  |
| `createdAt` | `integer` | yes | Created (epoch ms) |
| `updatedAt` | `integer` | yes | Last change (epoch ms) |
| `expiresAt` | `integer \| null` | yes | Expires (epoch ms, null = none) |
| `revokedAt` | `integer \| null` | yes | Revoked (epoch ms, null = none) |

### GrantPage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Grant[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### GrantResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Grant` | yes |  |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### KeyRotation

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `currentVersion` | `integer` | yes | The version rows are re-encrypted under. |
| `total` | `integer` | yes | Credentials with an encrypted key (whole table). |
| `reencrypted` | `string[]` | yes | Credential ids re-encrypted by this call. |
| `alreadyCurrent` | `integer` | yes | Rows of the range this call scanned that were already current. |
| `failed` | `object[]` | yes | Rows left unchanged: `conflict` (changed meanwhile; run again), `key_version_unknown` (its key is not loaded: set RB_MASTER_KEY_PREVIOUS), `decrypt_failed` (damaged or tampered row). |
| `nextCursor` | `string \| null` | yes | Send as `after` to continue; `null` once every row was visited. |
| `pending` | `integer` | yes | Rows (whole table) not on the current version after this call. |
| `versionsInUse` | `integer[]` | yes | Key versions stored after this call. `[currentVersion]` (or `[]`): the previous key can go. |

### KeyRotationResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `KeyRotation` | yes |  |

### Limits

Query limits; absent fields fall back to the defaults.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `maxLimit` | `integer` | no |  |
| `maxWindowDays` | `integer` | no |  |
| `rawNrql` | `boolean` | no |  |
| `maxResponseBytes` | `integer` | no |  |
| `eventTypes` | `object` | no |  |

### Project

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes |  |
| `slug` | `string` | yes |  |
| `name` | `string \| null` | yes |  |
| `defaultAccountId` | `integer` | yes |  |
| `allowedAccountIds` | `integer[]` | yes |  |
| `enabledTools` | `string[] \| null` | yes | null = every built-in tool. |
| `limits` | `Limits` | yes | Query limits; absent fields fall back to the defaults. |
| `defaultCredentialId` | `string \| null` | yes |  |
| `createdAt` | `integer` | yes | Created (epoch ms) |
| `updatedAt` | `integer` | yes | Last change (epoch ms) |
| `disabledAt` | `integer \| null` | yes | Disabled since (epoch ms, null = none) |

### ProjectPage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Project[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### ProjectResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Project` | yes |  |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### RateLimit

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `requests` | `integer` | yes |  |
| `perSeconds` | `integer` | yes |  |

### Revalidation

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes |  |
| `outcome` | `"valid" \| "invalid" \| "error" \| "skipped"` | yes |  |
| `code` | `string \| null` | yes |  |
| `accountsAdded` | `integer[]` | yes |  |
| `accountsRemoved` | `integer[]` | yes |  |

### RevalidationResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Revalidation` | yes |  |
| `credential` | `Credential` | yes | Masked credential metadata. Key plaintext and ciphertext are never returned. |

### RotateCredential

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | yes | New Relic User API key (`NRAK-…`). Accepted in the request body only; never returned. |

### RotateKeys

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `batchSize` | `integer` | no | Rows to re-encrypt in this call, 1-100 (default 25). |
| `after` | `string \| null` | no | `nextCursor` of the previous call; omit to start from the first row. |

### UpdateCredential

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | `string` | yes |  |

### UpdateProject

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `slug` | `string` | no | URL slug: `/p/{slug}/mcp`. |
| `name` | `string \| null` | no |  |
| `defaultAccountId` | `integer` | no |  |
| `allowedAccountIds` | `integer[]` | no |  |
| `enabledTools` | `string[] \| null` | no |  |
| `limits` | `object` | no |  |
| `defaultCredentialId` | `string \| null` | no | Credential used by grants that name none. |
| `disabled` | `boolean` | no | true refuses every request to the project. |

### UpdateUser

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `displayName` | `string \| null` | no |  |
| `role` | `"owner" \| "admin" \| "member"` | no |  |
| `disabled` | `boolean` | no | true disables the user: every grant of theirs and every key they own stops. |

### User

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes |  |
| `email` | `string` | yes |  |
| `displayName` | `string \| null` | yes |  |
| `idp` | `string \| null` | yes |  |
| `role` | `"owner" \| "admin" \| "member"` | yes |  |
| `createdAt` | `integer` | yes | Created (epoch ms) |
| `updatedAt` | `integer` | yes | Last change (epoch ms) |
| `disabledAt` | `integer \| null` | yes | Disabled since (epoch ms, null = none) |

### UserPage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `User[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### UserResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `User` | yes |  |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |
