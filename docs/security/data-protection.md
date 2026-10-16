# Data protection, field-level rules and outbound destinations

Three lists in one place: who sees which fields, where relic-bridge sends requests, and how each class of data is
protected. Written for [OWASP ASVS 5.0](asvs-l2.md) V8.1.2, V13.1.1 and V14.1.2. Every fact was checked against the
code (file named in the row). Paths are relative to the repository root.

**Reviewed:** 2026-10-15 (P8-95), against `main` at 0.11.0. Review again when a view, a fetch call site or a storage
table changes.

Related: [cryptographic inventory](cryptography.md) (keys, algorithms, lifetimes), [logging inventory](logging.md)
(sinks, redaction, retention), [THREAT_MODEL](../THREAT_MODEL.md).

## Field-level rules

Who sees which fields. The admin API builds every response field by field (`packages/http-app/src/admin/api.ts`, the
`*View` functions), so a stored field is never returned by accident.

| Data | Fields returned | Never returned | Who | Evidence |
|---|---|---|---|---|
| New Relic key | Label, region, owner, `keyHint` (last 4 characters), storage kind, key version, validation status, the key's New Relic user id and email, reachable account ids | The key, its ciphertext and IV | Owners and admins: all keys. Members: only their own, through `/me/credentials` (a key of someone else answers `404`). Shown to nobody after it is saved | `credentialView`; `packages/http-app/test/admin.test.ts` (no ciphertext in any response), `authz/member-self-service.test.ts` |
| Device token | Id, grant, prefix (the first characters, `rb_live_Ab3d`), label, created, expiry, last used, revoked | The token hash. The full token only once, in the answer that creates it | Owners and admins: all tokens. Members: tokens of their own grants | `tokenView`; `admin.test.ts` (no token hash in any response), `authz/harness.ts` |
| User | Id, email, display name, provider, role, created, updated, disabled | The provider's subject id, session ids | Owners and admins. A member sees only their own record, from `GET /session` | `userView` |
| Session | Role, user, CSRF token, `expiresAt`, `idleExpiresAt` | The session secret, its hash | Only the signed-in session itself (`GET /session`) | `packages/http-app/src/admin/api.ts` (`/session`) |
| Audit row | All columns of `audit_log` (NRQL as masked, hashed or full by `RB_AUDIT_NRQL`) | Tokens, keys, request bodies, results, emails and provider subjects (only a keyed `identityHash`) | Owners, admins and the admin token: every row. Members: only rows with their own user id (forced server side; asking for another user is `403`). Usage statistics: admins and owners | `listAudit` handler, `auditView`; `authz/routes.test.ts` ("audit (P4-05)"), `authz/ui-screens.test.ts` (also in the CSV) |
| OAuth client | Id, kind, name (not verified, shown as plain text), host, redirect hosts, registered and expiry times | Client secrets | Owners only | `OAuthClientSchema`; `authz/oauth-clients-admin.test.ts` |
| OAuth device (an app connected by OAuth) | Id, client kind and host, device label, project slug, grant, authorized time, end of the refresh lifetime | Access and refresh tokens, grant props | The user, for their own devices (`/me/oauth-devices`); owners and admins for any user | `packages/http-app/src/admin/schemas.ts` (`OAuthDevice`); `authz/ui-oauth-devices.test.ts` |
| Project, grant | Everything about them, including limits, quota and the account list | The credential's key (only its id) | Owners and admins. A member sees their own grants and the project's connect path through `/me/grants` | `projectView`, `grantView` |
| Config bundle | Projects, users, grants and settings | New Relic keys, unless `config export --with-credentials` seals them under a passphrase | Owners | `packages/http-app/src/admin/api.ts` (`/config/export`); [cryptography](cryptography.md#data-encryption) |
| Tool results (MCP) | What the grant allows: its tools, accounts and query limits | Other projects' data, accounts outside the grant | The device that holds the token | [access model](../guide/access-model.md), `authz/isolation.test.ts`, `authz/tools.test.ts` |

Rules that apply to every row:

- The role comes from the server-side session, never from a field the client sends. A body or query naming
  `ownerUserId` or `userId` on a `/me/*` route is refused.
- A row that exists but is not yours answers the same `404` as a row that doesn't exist.
- Secrets are never shown after they are saved. A secret that must be shown once (a device token, a setup link, a
  client secret) is returned only in the answer that creates it.
- Names that other people chose (OAuth client names, labels) are escaped on output and never trusted as identity.

## Outbound destinations

Every network destination relic-bridge connects to. There is no other outbound traffic: no telemetry to the
maintainers, no update check, no third-party fonts or scripts in the admin pages.

| Destination | What is sent | Credential sent | When | Code | Redirects |
|---|---|---|---|---|---|
| **New Relic NerdGraph**: `https://api.newrelic.com/graphql` (US), `https://api.eu.newrelic.com/graphql` (EU), `https://api.jp.newrelic.com/graphql` (JP) | GraphQL documents with variables: NRQL, entity searches and the other tools' queries; the key check on save | The New Relic User key (`API-Key` header) | Every tool call that is not served from the query cache; saving or re-checking a key | `packages/core/src/nerdgraph/endpoints.ts`, `client.ts` | Refused (`redirect: 'manual'`, a 3xx is an error) |
| **Identity providers**: `https://accounts.google.com` (Google), `https://github.com` and `https://api.github.com` (GitHub), the configured issuer (OIDC) | Discovery, authorization code exchange, userinfo, GitHub profile and organization lookups, GitHub token revocation | The client secret (token endpoint), the user's access token (userinfo, GitHub API) | At admin sign-in | `packages/auth/src/identity/` (`http.ts` `idpJson`, `google.ts`, `github.ts`, `oidc.ts`) | Refused (`idp_unavailable`) |
| **JWKS** of the provider (`jwks_uri` of the OIDC discovery document; `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` for Cloudflare Access) | A plain GET | None | At sign-in, cached 10 min, refetched for an unknown key id at most every 30 s | `packages/auth/src/identity/jwt.ts` (`remoteKeySource`) | Refused |
| **OAuth client metadata documents**: the https URL that an MCP client gives as its client id | A plain GET for a JSON document | None | When a client with such an id starts authorization | `packages/http-app/src/oauth/clients.ts` (policy), `apps/cli/src/cimd-fetch.ts` (Node), `apps/worker/src/cimd-fetch.ts` (Worker) | Refused. Only https, a DNS name on port 443, not our own host; no private, loopback or link-local address (checked at connect time on Node; the platform's own guard on Workers); 5 s, 5 KiB |
| **OTLP collector**: `RB_OTEL_ENDPOINT` | Metrics, spans and allow-listed log fields (see [logging](logging.md#otlp-export)) | `RB_OTEL_HEADERS` (typically a New Relic license key) | Only when `RB_OTEL=on` | `packages/http-app/src/telemetry.ts` | Refused |
| **`relic-bridge doctor`** (CLI, run by the operator) | `HEAD` to the NerdGraph endpoint of the region (a clock check); with `--remote`, `GET /health`, `/version`, the OAuth metadata and one `initialize` call to the operator's own server | The device token, for the one call to the operator's own server | Only when the operator runs the command | `apps/cli/src/manage/doctor.ts`, `doctor-clients.ts` | Not followed (`manual`) |
| **The operator's own server** (CLI `--remote` management commands) | Admin API calls | The admin token | Only when the operator runs a command | `apps/cli/src/manage/client.ts` | Refused (`error`) |

Notes:

- Destinations other than NerdGraph and the operator's own server are named by configuration (`RB_OTEL_ENDPOINT`, the
  OIDC issuer) or, for metadata documents, by a remote party. Only the metadata-document fetch takes a destination
  from untrusted input, and it has the guard above (ADR-0012, THREAT_MODEL T11).
- Pass-through mode sends the caller's own New Relic key to the same NerdGraph endpoints. It is the only mode where the
  key comes from a request, and it is never stored.
- Cloudflare's own services (D1, the Cache API, Durable Objects, Workers Logs) are the platform, not destinations that
  relic-bridge connects to by URL. The stderr log goes where the operator sends it.

## Data protection by class

| Class | Examples | Where it lives | Encryption | Retention | In logs |
|---|---|---|---|---|---|
| **New Relic keys** | User API keys in `credentials` | SQLite or D1 table `credentials` | AES-256-GCM under a key derived from the master key, with the credential id as AAD ([cryptography](cryptography.md#data-encryption)). stdio keeps keys in the environment, YAML or OS keychain, without relic-bridge encryption. Pass-through keys are never stored | Until the operator deletes or rotates the key | Never. The last 4 characters are shown in the API and panel | 
| **Master key and other server secrets** | `RB_MASTER_KEY`, `RB_ADMIN_TOKEN`, IdP client secrets, `RB_OTEL_HEADERS` | Environment, `_FILE` or a Worker secret. Held as `Secret` in memory | The master key derives every other key; nothing encrypts it (no vault, accepted in ASVS V13.3.1) | Until rotated ([cryptography](cryptography.md#long-lived-keys-and-secrets)) | Never. Redacted by pattern and by field name |
| **Bearer values** | Device tokens, OAuth tokens, sessions, setup links, sign-in state | `access_tokens`, `kv` | Stored as SHA-256 hashes (values have at least 128 bits of entropy). OAuth grant props are AES-256-GCM encrypted by the OAuth provider | Device token 90 days by default (or `never`). Admin session 30 min idle and 12 h absolute. OAuth access 1 h, refresh 30 days. Setup link 1 h. Sign-in state 10 min. Expired `kv` rows are purged hourly | Never, not even a prefix of a presented token |
| **User records** | Email, display name, provider and subject, role | Table `users` | None at rest beyond the database's own | Until the user is deleted | Email and subject never appear in audit rows (only the keyed `identityHash`); the admin API returns the email |
| **Configuration** | Projects, grants, limits, settings | Tables `projects`, `grants`, `settings` | None (no secrets in them) | Until changed or deleted | Changes are audit rows |
| **Audit log** | Tool calls, sign-ins, admin changes, NRQL (masked) | Table `audit_log` | None at rest beyond the database's own. NRQL literals are masked by default | 90 days (`RB_AUDIT_RETENTION_DAYS`, `0` keeps everything), purged hourly | This is the log. Never tokens, keys, bodies or results |
| **Quota counters** | Queries and inspected events per grant and period | Table `grant_usage` | None | 120 days after the last update | Not logged |
| **Query results** | NRQL answers (telemetry data of the customer's New Relic account) | Memory (stdio, `serve`): plaintext in process memory only. Workers: the Cache API | Workers: AES-256-GCM under a derived key, entry ids are HMACs. Memory: none | 30 s for moving windows (up to 300 s), 10 min for settled fixed windows. Results over 256 KiB are not stored | Never. Not in the audit log or the structured log |
| **MCP task records** | Results of long-running calls | `kv` | AES-256-GCM under a key derived from the task id | 15 min | Never |
| **Remembered consent** | "Don't ask again" for metadata-document clients | `kv` row `oauth-consent:<user>:<id>` | None (an index, not a secret) | 30 days; never for `mcp:write` | Audit rows `oauth.consent.*` |
| **Structured log** | Access lines, warnings, errors | stderr; Workers Logs | Whatever the operator's log system does | Operator's (Node); 3 days (Workers Free) or 7 days (Paid) | Redacted before it is written ([logging](logging.md)) |
| **Telemetry (OTLP)** | Metrics, spans, allow-listed log fields | The collector | In transit: https | The collector's | Not applicable. Never NRQL, ids, emails, IPs or secrets |
| **Config bundle and database export** | `config export`, `db export` files | A file the operator writes (`0600`, no overwrite without `--force`) | Keys in a bundle: AES-256-GCM under a passphrase (PBKDF2, 600 000 iterations). A database export keeps credentials as ciphertext and tokens as hashes | The operator's | Not applicable |

Two rules sit above the table:

- relic-bridge keeps no customer telemetry beyond the short-lived query cache. Results are returned to the caller
  and, for tools that fetch data, held only as the cache and task records above.
- Backups and database copies hold the same data as the database. Protect them like it. The master key is not in the
  database, so a copy of the database alone does not open the New Relic keys.
