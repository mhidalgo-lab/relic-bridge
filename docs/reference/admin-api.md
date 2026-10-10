<!-- GENERATED from the admin API OpenAPI document by packages/http-app/test/admin-docs.test.ts — do not edit. -->
<!-- Regenerate: pnpm docs:admin-api -->

# Admin API reference

API-first management of a relic-bridge instance: users, New Relic credentials, projects, grants, device tokens and the audit log. Authenticate with the bootstrap admin token (`Authorization: Bearer …`, role `owner`) or, from a browser, an admin session (cookie + `X-CSRF-Token`; roles `owner` > `admin` > `member`). New Relic keys are accepted in request bodies only and never returned; token hashes are never returned.

Base path: `/api/admin/v1`. OpenAPI 3.1 document: `GET /api/admin/v1/openapi.json` (admin token required).
Guide: [self-hosting](../guide/self-hosting.md#admin-api).

## Conventions

- **Authentication**: `Authorization: Bearer <RB_ADMIN_TOKEN>` on every request. Cookies and query-string
  credentials are never accepted; every failure is the same `401` and counts toward the per-IP failure throttle
  (past it, further failures get `429 rate_limited`; the valid token is still served).
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### PATCH /users/{id}

Update or disable a user

Demoting or disabling the last enabled owner is refused with `409 conflict`, `detail: last_owner` (P4-16).

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### POST /users/{id}/unbind

Clear a user's sign-in identity so they can sign in with another provider

Owners only (the admin token counts as owner). Clears the provider and subject the user is bound to and signs them out everywhere. The next verified sign-in whose email matches binds the user again, to whichever provider it came from, so anyone who controls that email at a configured provider can take the account: confirm the move with the user first. `confirm` must repeat the user's email address. Audited as `user.unbind`.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

Request body (`UnbindUser`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm` | `string` | yes | The user's current email address, typed again as a confirmation. Anyone who then signs in with a provider that asserts this verified email takes over the account. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `UserResponse` | Unbound |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### GET /users/{id}/oauth-devices

List a user's OAuth apps

Admins and owners. Empty when OAuth is off.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthDevicePage` | The OAuth devices |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### POST /users/{id}/oauth-devices/{deviceId}/revoke

Disconnect a user's OAuth app

Admins (an owner's apps: owners only). Revokes every token of that authorization and forgets the user's remembered approval for the app on that project.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |
| `deviceId` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthDeviceResponse` | Revoked |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

## Sessions

### POST /users/{id}/sessions/revoke

Sign a user out everywhere

Ends every admin session of the user at once (all devices). Members may do this for themselves only; admins for anyone but an owner. A role change or disabling a user does this automatically.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `SessionsRevokedResponse` | Sessions ended |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### GET /session

Who is calling: role, user and the CSRF token

Any role. With a session cookie it returns the CSRF token to send as `X-CSRF-Token` on changes. Sign out with `POST /auth/logout` (form field `_csrf`, `everywhere=1` for every device).

| Status | Body | Description |
| --- | --- | --- |
| 200 | `SessionResponse` | The caller |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### DELETE /grants/{id}

Delete a grant with its tokens

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 204 | — | Deleted |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### POST /grants/{id}/revoke

Revoke a grant (all its tokens stop working)

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `GrantResponse` | Revoked |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### POST /tokens/{id}/revoke

Revoke an access token

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AccessTokenResponse` | Revoked |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

## Keys

### POST /keys/rotate

Re-encrypt stored keys under the current master key (one batch)

Master-key rotation for hosts without local database access (a Worker on D1). Start the server with the new key as `RB_MASTER_KEY` and the old one as `RB_MASTER_KEY_PREVIOUS`, then call this until `nextCursor` is `null` (`relic-bridge keys rotate --remote` does). Each row is re-encrypted with a compare-and-swap, so every row stays readable, an interrupted run resumes, and a repeated run changes nothing. A wrong or retired master key answers `503 unavailable` (`detail`: `key_mismatch`, `key_version_retired`) before any row is touched. The previous key can be removed once `pending` is 0. A server may cap `batchSize` (Free-plan Workers: 40). Never returns key material.

Request body (`RotateKeys`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `batchSize` | `integer` | no | Rows to re-encrypt in this call, 1-100 (default 25). A Worker on the Free plan lowers the ceiling to 40 (one call stays under 50 D1 queries); a larger value is reduced, not refused, and `nextCursor` resumes. |
| `after` | `string \| null` | no | `nextCursor` of the previous call; omit to start from the first row. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `KeyRotationResponse` | What this batch did |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

## Identity

### POST /setup-links

Issue a single-use owner setup link

First-owner bootstrap (P4-01): the identity that signs in through this link becomes `owner` (the sign-in allowlist does not apply; email verification and identity conflicts still do). Single use; expires after `ttlMinutes` (default 60). The link is shown once, only its hash is stored. Needs sign-in to be configured (`RB_PUBLIC_URL` and an identity provider), else `422 not_permitted`.

Request body (`CreateSetupLink`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ttlMinutes` | `integer` | no | Lifetime in minutes, 1-10080 (default 60). |
| `provider` | `string` | no | Link straight to one sign-in provider (`google`, `github`, `cf-access`, …). |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `SetupLinkResponse` | Issued |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |
| 422 | `Error` | Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`) |

## Me

### GET /me/credentials

List my New Relic keys (masked)

Only keys owned by the signed-in user. Needs a session (the admin token owns nothing).

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `CredentialPage` | Your keys, without key material |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

### POST /me/credentials

Add my own New Relic User key

Validates the key and stores it encrypted, owned by you (it cannot be shared or given to someone else). At most 10 per user. The key is never returned.

Request body (`CreateMyCredential`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | `string` | yes |  |
| `region` | `"US" \| "EU" \| "JP"` | yes |  |
| `apiKey` | `string` | yes | New Relic User API key (`NRAK-…`). Accepted in the request body only; never returned. |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `CredentialResponse` | Created (masked) |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |
| 422 | `Error` | Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`) |
| 502 | `Error` | New Relic could not be asked (`upstream_unavailable`) |

### PATCH /me/credentials/{id}

Rename my key

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### DELETE /me/credentials/{id}

Delete my key

Refused (`409`) while one of your grants uses it: point the grant elsewhere first.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 204 | — | Deleted |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |

### POST /me/credentials/{id}/rotate

Replace my key

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
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |
| 422 | `Error` | Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`) |
| 502 | `Error` | New Relic could not be asked (`upstream_unavailable`) |

### POST /me/credentials/{id}/revalidate

Re-check my key against New Relic

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `RevalidationResponse` | Outcome |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### GET /me/grants

List my grants

Grants assigned to you (an administrator creates them), with the project to connect to.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `MyGrantPage` | Your grants |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

### PATCH /me/grants/{id}

Use one of my keys for my grant

Points one of your live grants at one of your own keys, or back at the project default (`null`, refused with 422 when an administrator pinned a key you do not own). The key must be yours and valid; the grant's scope (tools, accounts, limits) does not change.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

Request body (`SetMyGrantCredential`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `credentialId` | `string \| null` | yes | One of your own keys (`GET /me/credentials`); null = the project default. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `MyGrantResponse` | Updated |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |
| 422 | `Error` | Refused by a rule (`not_permitted`) or New Relic refused the key (`key_rejected`) |

### GET /me/tokens

List the device tokens of my grants

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |
| `grantId` | query | `string` | no | Only this grant. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AccessTokenPage` | Token metadata, never the token |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### POST /me/tokens

Issue a device token for one of my grants

Shown once. At most 20 live tokens per grant.

Request body (`CreateToken`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `grantId` | `string` | yes | Grant the token authenticates. |
| `label` | `string` | yes | Device name (`laptop`, `work-pc`). |
| `ttlSeconds` | `integer \| "never"` | no | Lifetime in seconds (default 90 days), or `'never'` (warned). |

| Status | Body | Description |
| --- | --- | --- |
| 201 | `AccessTokenCreated` | Created; the token is in the body, once |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 409 | `Error` | Conflicts with existing data (`conflict`, `read_only`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### POST /me/tokens/{id}/revoke

Revoke one of my device tokens

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AccessTokenResponse` | Revoked |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### GET /me/oauth-devices

List the apps I connected with OAuth

One row per app authorization (claude.ai, Claude Code, …): client, device name, project and grant. Empty when OAuth is off. Tokens are never returned.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthDevicePage` | Your OAuth devices |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

### POST /me/oauth-devices/{id}/revoke

Disconnect one of my OAuth apps

Revokes every access and refresh token of that authorization at once and forgets the remembered approval for the app on that project, so it has to ask again.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | path | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthDeviceResponse` | Revoked |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

## Oauth

### GET /oauth/clients

List OAuth clients

Owners only. Clients registered dynamically and cached metadata-document clients, newest first, at most 500. Names are chosen by whoever registered the client: show them as plain text. Empty when OAuth is off.

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthClientList` | The clients |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

### POST /oauth/clients/remove

Remove an OAuth client and everything issued to it

Owners only. Deletes the client record and revokes every device authorization of the client (all users: every access and refresh token) and forgets their remembered approvals. A metadata-document client can start over with consent. Audited as `oauth_client.remove`. 404 when there is no such client or OAuth is off.

Request body (`RemoveOAuthClient`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | `string` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthClientRemovalResponse` | Removed |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

### GET /oauth/registration

State of dynamic client registration

Owners only. `404` when OAuth is off.

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthRegistrationResponse` | The state |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |

### POST /oauth/registration

Turn dynamic client registration on or off

Owners only. Stored in settings and read by every process within about 5 seconds. Off: `/oauth/register` answers 404 and the server metadata has no `registration_endpoint`; existing clients keep working. It cannot turn on what `RB_OAUTH_DCR=off` disabled. Audited as `oauth_registration.set`.

Request body (`SetOAuthRegistration`):

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | yes |  |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `OAuthRegistrationResponse` | The new state |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |
| 404 | `Error` | No such resource (`not_found`) |
| 413 | `Error` | Body too large (`payload_too_large`) |
| 415 | `Error` | Body is not JSON (`unsupported_media_type`) |

## Audit

### GET /audit

Query the audit log (newest first)

Admins and owners read every row. A member (session) reads only rows whose `userId` is their own: the filter is forced, and asking for another `userId` is `403`.

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
| `order` | query | `"newest" \| "slowest"` | no | `newest` (default) pages with `cursor`. `slowest`: rows that recorded a duration, longest first; one page of `limit` rows, no cursor. |
| `limit` | query | `integer` | no | Page size, 1-200 (default 50). |
| `cursor` | query | `string` | no | `nextCursor` from the previous page. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AuditPage` | Audit rows |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

### GET /audit/stats

Tool-call statistics over a time window

One bounded aggregate over `tool_call` rows in `[since, until)` (at most 90 days, default the last 7): calls, errors, denied, durations and inspected events per tool, project, grant, device token or day. Admins and owners only.

| Parameter | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `groupBy` | query | `"action" \| "project" \| "grant" \| "token" \| "day"` | no | Group tool calls by tool (`action`, default), project, grant, device token or UTC day. |
| `since` | query | `string` | no | Inclusive lower bound (default: 7 days before `until`; at most 90 days): epoch ms or an ISO 8601 date-time. |
| `until` | query | `string` | no | Exclusive upper bound (default: now): epoch ms or an ISO 8601 date-time. |
| `action` | query | `string` | no | Only this tool. |
| `projectId` | query | `string` | no | Only this project. |
| `userId` | query | `string` | no | Only this user. |
| `grantId` | query | `string` | no | Only this grant. |
| `tokenId` | query | `string` | no | Only this access token. |
| `limit` | query | `integer` | no | Groups returned, 1-100 (default 50): most calls first; `day`: newest first. |

| Status | Body | Description |
| --- | --- | --- |
| 200 | `AuditStats` | Statistics |
| 403 | `Error` | Session refused: role too low, missing/invalid CSRF token or cross-origin request (`forbidden`) |

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

### AuditStats

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `AuditStatsRow[]` | yes |  |
| `window` | `object` | yes |  |

### AuditStatsRow

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | `string \| null` | yes | The group value (null: calls without one, e.g. no project). |
| `calls` | `integer` | yes |  |
| `errors` | `integer` | yes | Calls with status `error`. |
| `denied` | `integer` | yes | Calls with status `denied`. |
| `durationSumMs` | `integer` | yes | Sum of recorded durations; mean = sum / durationCount. |
| `durationCount` | `integer` | yes | Calls that recorded a duration. |
| `maxDurationMs` | `integer \| null` | yes |  |
| `inspectedCount` | `integer` | yes | Events New Relic reported inspecting, summed. |

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

### CreateMyCredential

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `label` | `string` | yes |  |
| `region` | `"US" \| "EU" \| "JP"` | yes |  |
| `apiKey` | `string` | yes | New Relic User API key (`NRAK-…`). Accepted in the request body only; never returned. |

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

### CreateSetupLink

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ttlMinutes` | `integer` | no | Lifetime in minutes, 1-10080 (default 60). |
| `provider` | `string` | no | Link straight to one sign-in provider (`google`, `github`, `cf-access`, …). |

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

### MyGrant

A grant assigned to the caller, with the project it is for.

_No fields._

### MyGrantPage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `MyGrant[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### MyGrantResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `MyGrant` | yes | A grant assigned to the caller, with the project it is for. |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### OAuthClient

An OAuth client known to this server (P5-08). No secrets.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes | The client id: a metadata document URL or a registered id. |
| `kind` | `"metadata_document" \| "dynamic"` | yes |  |
| `name` | `string \| null` | yes | Name from the registration or metadata document: chosen by whoever registered the client, not verified. Show it as plain text only. |
| `host` | `string \| null` | yes | Metadata-document clients: the host of the client id, which vouches for it. Null otherwise. |
| `redirectHosts` | `string[]` | yes | Hosts of the redirect URIs. |
| `registeredAt` | `integer \| null` | yes | Registered or fetched (epoch ms, null = none) |
| `expiresAt` | `integer \| null` | yes | End of the record (a metadata document is fetched again after it) (epoch ms, null = none) |

### OAuthClientList

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `OAuthClient[]` | yes |  |
| `nextCursor` | `null` | yes | Always null: the list is one page of the newest 500 clients. |
| `truncated` | `boolean` | yes | True when more clients exist than the page shows (the oldest are left out). |

### OAuthClientRemoval

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `client` | `OAuthClient` | yes | An OAuth client known to this server (P5-08). No secrets. |
| `devicesRevoked` | `integer` | yes | Device authorizations revoked, every user. |
| `approvalsForgotten` | `integer` | yes | Remembered 'don't ask again' approvals. |
| `complete` | `boolean` | yes | False when the call stopped at its work budget: repeat the same removal until it is true (the client record is already gone). |

### OAuthClientRemovalResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `OAuthClientRemoval` | yes |  |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### OAuthDevice

An app connected with OAuth (P5-05). Tokens are never returned.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | yes | `oauth_…`: also the `tokenId` of its audit rows. |
| `userId` | `string` | yes |  |
| `clientId` | `string` | yes | The OAuth client (a metadata document URL or a registered id). |
| `clientName` | `string \| null` | yes | Name from the client registration or metadata document: not verified. |
| `clientKind` | `"metadata_document" \| "dynamic"` | yes |  |
| `clientHost` | `string \| null` | yes | Metadata-document clients: the host of the client id. Null for dynamic ones. |
| `label` | `string \| null` | yes | Device name typed on the consent page. |
| `projectSlug` | `string \| null` | yes |  |
| `grantId` | `string \| null` | yes | The grant the app was approved with (revoking it revokes the device). |
| `createdAt` | `integer` | yes | Authorized (epoch ms) |
| `expiresAt` | `integer \| null` | yes | End of the refresh lifetime: the app must ask again after it (epoch ms, null = none) |

### OAuthDevicePage

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `OAuthDevice[]` | yes |  |
| `nextCursor` | `string \| null` | yes | Pass as `cursor` for the next page; null at the end. |

### OAuthDeviceResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `OAuthDevice` | yes | An app connected with OAuth (P5-05). Tokens are never returned. |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

### OAuthRegistration

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | yes | What `/oauth/register` does now. |
| `deployment` | `boolean` | yes | `RB_OAUTH_DCR` (default on). When off, the switch cannot turn registration on. |
| `setting` | `boolean` | yes | The runtime switch (on when never set). |

### OAuthRegistrationResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `OAuthRegistration` | yes |  |
| `warnings` | `string[]` | no | Non-fatal notes about the change (e.g. parts of a grant the project does not allow). |

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

### RemoveOAuthClient

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `clientId` | `string` | yes |  |

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
| `batchSize` | `integer` | no | Rows to re-encrypt in this call, 1-100 (default 25). A Worker on the Free plan lowers the ceiling to 40 (one call stays under 50 D1 queries); a larger value is reduced, not refused, and `nextCursor` resumes. |
| `after` | `string \| null` | no | `nextCursor` of the previous call; omit to start from the first row. |

### Session

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"session" \| "admin_token"` | yes | `session`: a signed-in browser (cookie). `admin_token`: the bootstrap admin token. |
| `role` | `"owner" \| "admin" \| "member"` | yes | Effective role. The admin token counts as `owner`. |
| `user` | `object` | yes |  |
| `csrfToken` | `string \| null` | yes | Send it as `X-CSRF-Token` on every POST/PATCH/DELETE made with the session cookie. Null for the admin token. |
| `provider` | `string \| null` | yes | Sign-in provider of the session. |
| `expiresAt` | `integer \| null` | yes | Absolute end of the session (epoch ms). |
| `idleExpiresAt` | `integer \| null` | yes | When the session ends unless another request comes (epoch ms). |

### SessionResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `Session` | yes |  |

### SessionsRevoked

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `userId` | `string` | yes |  |
| `revoked` | `integer` | yes | How many live sessions were ended. |

### SessionsRevokedResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `SessionsRevoked` | yes |  |

### SetMyGrantCredential

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `credentialId` | `string \| null` | yes | One of your own keys (`GET /me/credentials`); null = the project default. |

### SetOAuthRegistration

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | yes |  |

### SetupLink

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | yes | Open it in a browser and sign in: that identity becomes `owner`. Shown once; single use. |
| `expiresAt` | `integer` | yes | Epoch milliseconds. |
| `provider` | `string \| null` | yes |  |

### SetupLinkResponse

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | `SetupLink` | yes |  |

### UnbindUser

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm` | `string` | yes | The user's current email address, typed again as a confirmation. Anyone who then signs in with a provider that asserts this verified email takes over the account. |

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
