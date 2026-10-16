# OWASP ASVS 5.0 Level 2 checklist

relic-bridge checked against the [OWASP Application Security Verification Standard](https://owasp.org/www-project-application-security-verification-standard/)
**5.0.0** (released 2025-05-30, the current stable release per the [OWASP ASVS releases](https://github.com/OWASP/ASVS/releases)),
Level 2: every L1 and L2 requirement of the chapters that apply. Prepared in P8-01 (2026-10-14) for the independent
review (P8-02). Refreshed in P8-95 (2026-10-15) after P8-65, P8-66 and P8-73, and again after P8-85 and P8-96. Requirement text is not copied here (the standard is CC BY-SA 4.0); the **Topic** column is a short
paraphrase, so read each id against the standard.

**Applies**: whether the requirement can apply to relic-bridge. **Status**: *met*, *partial* (the gap is stated),
*not met*, *accepted* (a deliberate deviation with its reason), or *N/A*. **Evidence** names code and tests; paths
are relative to the repository root, with these short forms: `core/` = `packages/core/`, `auth/` = `packages/auth/`,
`http/` = `packages/http-app/`, `ui/` = `packages/admin-ui/`, `cli/` = `apps/cli/`, `worker/` = `apps/worker/`,
`authz/` = `packages/http-app/test/authz/`. Threat ids (`T4`) point to [THREAT_MODEL.md](../THREAT_MODEL.md) section
4a, which has the fuller evidence per threat.

What relic-bridge is, for scoping: an MCP server (Streamable HTTP and stdio) that calls New Relic NerdGraph as a
**GraphQL client** with stored User API keys; an **OAuth 2.1 authorization server** for MCP clients (wrapping
`@cloudflare/workers-oauth-provider` 1.2.1); an **OIDC / OAuth client** for admin sign-in (Google, GitHub, generic OIDC,
Cloudflare Access); a server-rendered admin panel and consent page; an MCP Apps chart view in the client's iframe. It
has **no passwords**, no file uploads, no WebSockets and no WebRTC.

## Summary

| Chapter | Applies | Met | Partial | Accepted | N/A |
|---|---|---|---|---|---|
| V1 Encoding and Sanitization | yes | 14 | 0 | 0 | 13 |
| V2 Validation and Business Logic | yes | 9 | 1 | 0 | 1 |
| V3 Web Frontend Security | yes | 18 | 0 | 1 | 0 |
| V4 API and Web Service | yes | 4 | 0 | 1 | 5 |
| V5 File Handling | partly (config bundle, audit CSV) | 5 | 0 | 0 | 4 |
| V6 Authentication | yes (IdP sign-in, tokens) | 9 | 2 | 0 | 24 |
| V7 Session Management | yes | 15 | 0 | 2 | 1 |
| V8 Authorization | yes | 7 | 0 | 0 | 0 |
| V9 Self-contained Tokens | consumed only (IdP ID tokens, Access assertions) | 6 | 0 | 0 | 1 |
| V10 OAuth and OIDC | yes (server and client) | 24 | 0 | 1 | 4 |
| V11 Cryptography | yes | 12 | 1 | 0 | 1 |
| V12 Secure Communication | yes (TLS at the hosting layer) | 3 | 1 | 2 | 3 |
| V13 Configuration | yes | 10 | 1 | 2 | 0 |
| V14 Data Protection | yes | 9 | 0 | 0 | 0 |
| V15 Secure Coding and Architecture | yes | 13 | 0 | 0 | 0 |
| V16 Security Logging and Error Handling | yes | 14 | 2 | 0 | 0 |
| V17 WebRTC | no | 0 | 0 | 0 | 7 |

No requirement is *not met*. The partial items are listed under [open items](#open-items) at the end.

## V1 Encoding and Sanitization

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V1.1.1 | 2 | Decode to canonical form once, before validation | yes | met | CIMD client ids must be canonical (`new URL(id).href === id`, `http/src/oauth/clients.ts` `clientIdUrlProblem`); `http/src/identity.ts` `safeNextPath` re-checks the parsed result. Tests: `authz/oauth-suite.ts` (client ids), `http/test/fuzz.test.ts`, `auth/test/p4-review-signin.test.ts` |
| V1.1.2 | 2 | Encode as the last step, for the target interpreter | yes | met | The `nrql` tag quotes at render time (`core/src/nrql/template.ts`); Hono JSX escapes at render; GraphQL values are variables only (`core/src/nerdgraph/document.ts`). Tests: `core/test/nrql-template.test.ts`, `core/test/fuzz.test.ts`, `scripts/test/check-ui-escaping.test.ts` |
| V1.2.1 | 1 | Context-aware output encoding for HTML | yes | met | Admin UI and consent page are Hono JSX with no `raw()` / HTML sinks (`scripts/check-ui-escaping.ts` in `pnpm lint`); CSP without inline script (`ui/src/headers.ts`). Tests: `scripts/test/check-ui-escaping.test.ts`, `authz/consent-suite.ts` (escaped client name) |
| V1.2.2 | 1 | Encode untrusted data in URLs | yes | met | URLs built with `URLSearchParams` / `encodeURIComponent` (`auth/src/identity/oidc.ts`, `core/src/links.ts`); `safeNextPath` same-origin only. Tests: `core/test/tools-links.test.ts` ("never lets a value change the host or path"), `http/test/fuzz.test.ts` |
| V1.2.3 | 1 | Encode when building JavaScript / JSON | yes | met | JSON only through `JSON.stringify` / `c.json`; no inline script; the chart view uses `textContent` (T27). Tests: `scripts/test/chart-app.test.ts` |
| V1.2.4 | 1 | Parameterized database queries | yes | met | SQLite `prepare()` with bound parameters (`packages/storage-sqlite/src/repos.ts`), D1 `.bind()` (`packages/storage/src/d1.ts`); dynamic `WHERE` built from constant fragments. NRQL through the `nrql` tag (T4), entity search through `entityQuery`. Tests: `packages/storage-sqlite/test/sqlite.test.ts`, `http/test/p4-review-sessions.test.ts` (injection-shaped filters), `core/test/fuzz.test.ts` |
| V1.2.5 | 1 | OS command injection | yes | met | One process spawn: `cli/src/keychain.ts` (`spawnSync` with an argument array, names allow-listed, secret on stdin). Test: `cli/test/keychain.test.ts` |
| V1.2.6 | 2 | LDAP injection | no | N/A | No LDAP. |
| V1.2.7 | 2 | XPath injection | no | N/A | No XML or XPath. |
| V1.2.8 | 2 | LaTeX processors | no | N/A | No LaTeX. |
| V1.2.9 | 2 | Escape regular expression input | yes | met | No pattern is built from input (`new RegExp(` does not occur in `packages/*/src`, `apps/*/src`); input never becomes a `LIKE` pattern in SQL. |
| V1.3.1 | 1 | Sanitize WYSIWYG HTML | no | N/A | No HTML input is accepted. |
| V1.3.2 | 1 | No `eval()` or dynamic code execution | yes | met | No `eval` / `new Function` in product code; the UI lint also bans dynamic code in the view and panel scripts. |
| V1.3.3 | 2 | Sanitize data before dangerous contexts | yes | met | `nrql.identifier()` strict charset; literals refuse control characters and lone surrogates; display names refuse control, format, separator and private-use characters and mixed-script words (`safeClientName`). Tests: `core/test/fuzz.test.ts`, `http/test/fuzz.test.ts`, `authz/oauth-suite.ts` |
| V1.3.4 | 2 | Sanitize user-supplied SVG | no | N/A | No user SVG; the chart view builds SVG with DOM calls from numbers and text nodes. |
| V1.3.5 | 2 | Scriptable / template content from users | yes | met | Telemetry and client-supplied text are never interpreted as markup, Markdown, CSS or templates (JSX escaping, `textContent`). Tests: `scripts/test/chart-app.test.ts`, `ui/test/consent.test.tsx` |
| V1.3.6 | 2 | SSRF protection | yes | met | The only fetch to a caller-named URL is the CIMD document: canonical https DNS name, port 443, connect-time address check on Node (`cli/src/cimd-fetch.ts`), `global_fetch_strictly_public` on Workers, no redirects, 5 s, 5 KiB, per-address budget (T11). NerdGraph hosts are fixed. Tests: `cli/test/cimd-fetch.test.ts`, `authz/oauth-suite.ts`, `http/test/fuzz.test.ts` (IP classification) |
| V1.3.7 | 2 | Template injection | no | N/A | No server-side template engine; JSX components are code. |
| V1.3.8 | 2 | JNDI injection | no | N/A | Not Java. |
| V1.3.9 | 2 | Memcache injection | no | N/A | No memcache. |
| V1.3.10 | 2 | Format string injection | no | N/A | The logger takes structured fields, not format strings. |
| V1.3.11 | 2 | SMTP / IMAP injection | no | N/A | No mail. |
| V1.4.1 | 2 | Memory-safe strings and pointers | no | N/A | TypeScript on V8; no native code of our own. |
| V1.4.2 | 2 | Integer overflow | yes | met | Safe-integer and range checks on ids, TTLs, limits and timeouts (`auth/src/tokens/service.ts`, `auth/src/identity/session.ts`, admin `checkRange`, settings parsers). Tests: `auth/test/session.test.ts`, settings fuzz tests (`cli/test/fuzz.test.ts`, `worker/test/fuzz-settings.test.ts`) |
| V1.4.3 | 2 | Release memory and resources | no | N/A | Managed memory. |
| V1.5.1 | 1 | Restrictive XML parser configuration | no | N/A | No XML parser. |
| V1.5.2 | 2 | Safe deserialization | yes | met | Only `JSON.parse` and strict zod schemas; YAML with a strict schema, `maxAliasCount: 0`, unique keys (`packages/storage/src/yaml.ts`). Tests: `http/test/p4-review-sessions.test.ts` (mass assignment), `cli/test/config-transfer.test.ts` (aliases refused), `cli/test/fuzz.test.ts` |

## V2 Validation and Business Logic

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V2.1.1 | 1 | Input validation rules documented | yes | met | [Tool reference](../reference/tools.md) and admin API reference generated from the schemas (checked in `pnpm lint`); [query limits](../guide/query-limits.md); [OAuth](../dev/oauth.md). |
| V2.1.2 | 2 | Cross-field consistency rules documented | yes | met | [Access model](../guide/access-model.md), ARCHITECTURE, [OAuth](../dev/oauth.md) (resource = project, key owner vs grant user). |
| V2.1.3 | 2 | Business-logic limits documented | yes | met | [Query limits](../guide/query-limits.md), [admin guide quotas](../guide/admin-guide.md), [Cloudflare limits](../guide/cloudflare-limits.md), [OAuth](../dev/oauth.md) caps, [admin access](../guide/admin-access.md) session cap. |
| V2.2.1 | 1 | Positive input validation | yes | met | zod `strictObject` on the admin API (`http/src/admin/schemas.ts`) and tool inputs; allow-list patterns for slugs, tokens, ids. Tests: `core/test/contract.test.ts` (unknown arguments refused), `http/test/admin.test.ts` |
| V2.2.2 | 1 | Validation at a trusted service layer | yes | met | All validation on the server (SSR panel, API middleware). Tests: `authz/routes.test.ts` |
| V2.2.3 | 2 | Combinations of related values are reasonable | yes | met | `auth/src/access/resolve.ts` (project, grant, key owner, user); OAuth props cross-checked at every issuance (`http/src/oauth/server.ts`). Tests: `auth/test/access-resolve.test.ts`, `authz/oauth-suite.ts` |
| V2.3.1 | 1 | Flows run in the expected order | yes | met | Single-use, browser-bound sign-in transaction (`auth/src/identity/login.ts`); OAuth authorize → consent → single-use code → token; single-use setup links and write approvals. Tests: `auth/test/identity.test.ts`, `authz/oauth-suite.ts`, `http/test/fuzz-http.test.ts` |
| V2.3.2 | 2 | Documented limits are implemented | yes | met | Quotas (`http/src/quota.ts`), rate limits, device, session, registration and metadata-client caps, per-user key and token caps. Tests: `http/test/quota.test.ts`, `authz/member-self-service.test.ts`, `authz/oauth-lifecycle-suite.ts` |
| V2.3.3 | 2 | Operations succeed or roll back as a whole | yes | partial | Single-statement atomic writes (`users.bind` compare-and-set, last-owner guard, `kv.take` / `increment`, quota reserve); key rotation is resumable with compare-and-swap. Gap: multi-row admin operations (revoking the OAuth devices of a revoked grant, client removal) are resumable, not all-or-nothing; deny-by-default checks at use cover the window. |
| V2.3.4 | 2 | Locking for limited-quantity resources | no | N/A | No limited-quantity resources. |
| V2.4.1 | 2 | Anti-automation | yes | met | Per-IP, failure, sign-in, OAuth, token, grant and write rules (`http/src/rate-limit-hooks.ts`), shared registration and metadata-fetch counters. Tests: `http/test/rate-limit.test.ts`, `oauth-rate-limit.test.ts`. Workers buckets are per isolate unless the shared limiter is on (documented). |

## V3 Web Frontend Security

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V3.2.1 | 1 | Responses not rendered in an unintended context | yes | met | `nosniff`, CSP `default-src 'none'` and CORP on every response (`http/src/security.ts`); fetch-metadata checks on cookie routes. Test: `http/test/app.test.ts` ("sets security headers on every response") |
| V3.2.2 | 1 | Text shown with safe rendering functions | yes | met | JSX auto-escaping (lint-enforced); chart view `createElement` / `textContent` only. Tests: `scripts/test/chart-app.test.ts`, `ui/test/p4-review-ui.test.ts` |
| V3.3.1 | 1 | Cookies `Secure` (or `__Host-`) | yes | met | `__Host-rb_session`, `__Host-rb_login`, `__Host-rb_flash` with `Secure`; plain names only when `RB_PUBLIC_URL` is http on loopback. Test: `http/test/identity.test.ts` |
| V3.3.2 | 2 | `SameSite` per purpose | yes | met | `SameSite=Lax` (Strict would drop the cookie after the IdP redirect); CSRF covered by token, `Origin` and fetch metadata. Test: `http/test/p4-review-sessions.test.ts` |
| V3.3.3 | 2 | `__Host-` prefix | yes | met | All cookies `__Host-` on https, `Path=/`, no `Domain`; a cookie named twice is no cookie. Test: `http/test/p4-review-sessions.test.ts` (cookie tossing) |
| V3.3.4 | 2 | `HttpOnly` for script-inaccessible cookies | yes | met | `HttpOnly` on every cookie; the page gets a separate CSRF token. Test: `http/test/p4-review-sessions.test.ts` |
| V3.4.1 | 1 | HSTS on all responses | yes | met | `max-age=31536000; includeSubDomains` on every response when the request is https, when `RB_HSTS=true`, or (P8-66) when `RB_PUBLIC_URL` is https and `RB_HSTS` is unset or `auto` (`hstsAlways`, set in `cli/src/serve.ts`; `http/src/app.ts`); always on Workers, including the boot-failure 503 (`worker/src/worker.ts` `unavailable`). `RB_HSTS=false` turns it off. Deriving HSTS from the public URL does not relax the pass-through TLS guard. Tests: `http/test/app.test.ts` (`hstsAlways`), `cli/test/serve.test.ts` (settings parser), `http/test/passthrough.test.ts` (guard still refuses plain http), `worker/test/worker.test.ts` (503 carries HSTS). A plain-http `RB_PUBLIC_URL` sends none unless `RB_HSTS=true`, by design (no `X-Forwarded-Proto` trust) |
| V3.4.2 | 1 | CORS `Allow-Origin` fixed or allow-listed | yes | met | Off by default; `RB_CORS_ORIGINS` allow-list without credentials; `Origin` checked before the OAuth provider's CORS. Test: `http/test/app.test.ts` ("CORS is off by default…") |
| V3.4.3 | 2 | CSP with `object-src` / `base-uri` restrictions | yes | met | JSON: `default-src 'none'; frame-ancestors 'none'`; HTML: `UI_CSP` (`script-src 'self'`, `base-uri 'none'`, Trusted Types, no inline code); chart view meta CSP. Tests: `authz/ui.test.ts`, `ui/test/app.test.ts` |
| V3.4.4 | 2 | `X-Content-Type-Options: nosniff` | yes | met | On every response including errors and the Worker's 503. Tests: `http/test/app.test.ts`, `worker/test/worker.test.ts`, `cli/test/serve-e2e.test.ts` |
| V3.4.5 | 2 | Referrer policy | yes | met | `no-referrer` on JSON; `same-origin` on HTML pages (`no-referrer` would make form POSTs send `Origin: null`). Test: `http/test/p4-review-ui.test.ts` |
| V3.4.6 | 2 | `frame-ancestors` on every response | yes | met | `frame-ancestors 'none'` plus `X-Frame-Options: DENY`; a handler CSP survives only if it is exactly the UI policy. Tests: `authz/ui.test.ts`, `authz/consent-suite.ts` |
| V3.5.1 | 1 | CSRF protection without relying on preflight | yes | met | MCP and admin bearer routes use an `Authorization` header (not ambient); cookie routes need a synchronizer token, exact `Origin` and `Sec-Fetch-Site`. Tests: `http/test/p4-review-sessions.test.ts`, `ui/test/app.test.ts` (CSRF matrix), `authz/consent-suite.ts` |
| V3.5.2 | 1 | Preflight cannot be bypassed | yes | met | The admin API requires `application/json` bodies (415 otherwise) on top of the token checks. Test: `http/test/admin.test.ts` |
| V3.5.3 | 1 | Sensitive actions use non-GET methods | yes | met | State changes are POST, PATCH or DELETE; the audit CSV refuses cross-site navigations; GET sign-in start is rate limited and stores only a short-lived row. Test: `http/test/p4-review-sessions.test.ts` |
| V3.5.4 | 2 | Separate applications on separate hostnames | yes | accepted | The panel, consent page, OAuth server and MCP API share one origin (`RB_PUBLIC_URL`) by design: one deployment, one host. Mitigated by the strict CSP, `__Host-` cookies, bearer vs cookie separation and no user content in pages. |
| V3.5.5 | 2 | `postMessage` origin checks | yes | met | The chart view accepts only `event.source === parent` JSON-RPC and sends no data back (a sandboxed MCP Apps iframe cannot check an origin). Test: `scripts/test/chart-app.test.ts` |
| V3.7.1 | 2 | Supported client-side technologies only | yes | met | Server-rendered HTML plus one small same-origin script with SRI and hashed names (`ui/assets/admin.js`). |
| V3.7.2 | 2 | No automatic redirect to unlisted hosts | yes | met | `safeNextPath` same-origin only; OAuth redirects only to registered URIs. Tests: `auth/test/p4-review-signin.test.ts`, `http/test/fuzz.test.ts`, `http/test/fuzz-http.test.ts` |

## V4 API and Web Service

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V4.1.1 | 1 | `Content-Type` matches the body | yes | met | JSON `application/json`; HTML `text/html; charset=utf-8`; CSV and SSE their own types. |
| V4.1.2 | 2 | Only user-facing endpoints redirect HTTP → HTTPS | yes | accepted | The app never redirects; TLS and its redirect belong to the hosting layer (the Caddy example and Cloudflare). Pass-through refuses plain HTTP off loopback (`tls_required`). Test: `http/test/passthrough.test.ts` |
| V4.1.3 | 2 | Intermediary headers cannot be spoofed | yes | met | `X-Forwarded-For` counts only for `RB_TRUSTED_PROXY_HOPS` from the right (`http/src/client-ip.ts`); Workers use `CF-Connecting-IP`. Tests: `http/test/rate-limit.test.ts`, `http/test/fuzz.test.ts` (client addresses) |
| V4.2.1 | 2 | Consistent HTTP message boundaries | yes | met | Node's strict parser; `Content-Length` validated; 16 KiB header cap; streamed bodies bounded. Tests: `http/test/app.test.ts` (413), `http/test/fuzz-http.test.ts` (413 exactly over the cap), `http/test/fuzz.test.ts` (body peek) |
| V4.3.1 | 2 | GraphQL query cost limits | yes | met | relic-bridge serves no GraphQL; outbound NerdGraph documents are static `defineDocument` constants and NRQL passes `enforceQueryLimits` (T5, T22). Tests: `core/test/nrql-limits.test.ts`, `core/test/no-raw-nerdgraph.test.ts` |
| V4.3.2 | 2 | GraphQL introspection disabled | no | N/A | No GraphQL API is served. |
| V4.4.1–V4.4.4 | 1–2 | WebSocket transport, origin and session tokens | no | N/A | No WebSockets (MCP Streamable HTTP is POST + SSE). |

## V5 File Handling

The only file-like inputs are the configuration bundle (`config import`) and the only download is the audit CSV.

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V5.1.1 | 2 | Permitted file types and sizes documented | yes | met | [Migrating config](../guide/migrating-config.md): YAML / JSON, entity caps, 1 MiB CLI, 64 KiB API, aliases refused. |
| V5.2.1 | 1 | Size limits | yes | met | `cli/src/manage/transfer.ts` 1 MiB (stat before read); admin API body cap. Tests: `cli/test/config-transfer.test.ts`, `http/test/admin.test.ts` |
| V5.2.2 | 1 | Content validated, extension not trusted | yes | met | Strict YAML parse and a strict zod bundle schema (`http/src/admin/schemas.ts`). Test: `cli/test/config-transfer.test.ts` |
| V5.2.3 | 2 | Compressed files | no | N/A | No archives are accepted. |
| V5.3.1 | 1 | Uploaded files not executed | no | N/A | No files are stored or served from a folder. |
| V5.3.2 | 1 | File paths not built from user names | no | N/A | Server paths are not built from input; CLI paths are the operator's (`--out` created `wx`, `0600`). |
| V5.4.1 | 2 | User-submitted filenames ignored | yes | met | The CSV name is server-generated (`audit-<day>.csv`, `ui/src/screens/audit.tsx`). Test: `ui/test/audit-usage.test.ts` |
| V5.4.2 | 2 | Served filenames encoded | yes | met | Server-generated date name; nothing to encode. |
| V5.4.3 | 2 | Antivirus on untrusted files | no | N/A | No files from untrusted sources are served. |

## V6 Authentication

relic-bridge has no passwords: people sign in through an identity provider; machines use per-device `rb_` tokens,
OAuth tokens or the bootstrap admin token.

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V6.1.1 | 1 | Throttling and anti-automation documented | yes | met | THREAT_MODEL T1, T14, T20; `http/src/rate-limit-hooks.ts` header; [Cloudflare limits](../guide/cloudflare-limits.md). |
| V6.1.2 | 2 | Context-specific password word list | no | N/A | No passwords. |
| V6.1.3 | 2 | All authentication pathways documented | yes | met | [Admin access](../guide/admin-access.md), [identity providers](../guide/identity-providers.md), [OAuth](../dev/oauth.md), ARCHITECTURE, T1/T14. |
| V6.2.1–V6.2.12 | 1–2 | Password rules, change, breach checks | no | N/A | No passwords. |
| V6.3.1 | 1 | Credential stuffing and brute force | yes | met | Failure throttle, sign-in and OAuth per-IP rules, 256-bit tokens, weak admin tokens refused at boot (`http/src/admin/token.ts`). Tests: `http/test/rate-limit.test.ts`, `admin-token.test.ts` |
| V6.3.2 | 1 | No default accounts | yes | met | No default users or credentials; `RB_ADMIN_TOKEN` operator-supplied (placeholders refused); the first owner comes from a single-use setup link. Test: `http/test/admin-token.test.ts` |
| V6.3.3 | 2 | MFA or equivalent for L2 | yes | partial | People sign in through IdPs, whose MFA policy applies; relic-bridge does not require or check an MFA claim. The admin token and device tokens are single-factor bearer secrets (high entropy, revocable). |
| V6.3.4 | 2 | No undocumented pathways | yes | met | Every pathway is in the authz matrix with the same generic 401; the route-table guard fails on a new route. Test: `authz/routes.test.ts` |
| V6.4.1 | 1 | Random, expiring activation codes | yes | met | Setup links: 256-bit, hash-only, single-use (`kv.take`), 1 min–7 days, default 1 h (`auth/src/identity/login.ts`). Tests: `auth/test/p4-review-signin.test.ts` |
| V6.4.2 | 1 | No password hints or secret questions | yes | met | None exist. |
| V6.4.3 | 2 | Password reset | no | N/A | No passwords (the IdP owns recovery). |
| V6.4.4 | 2 | MFA factor loss and identity proofing | no | N/A | No factors held by relic-bridge; re-binding a user to another identity is owner-only with a typed confirmation. |
| V6.5.1–V6.5.5 | 2 | Lookup secrets, OTP and out-of-band codes | no | N/A | None used (the setup link is covered by V6.4.1). |
| V6.6.1–V6.6.3 | 2 | PSTN and out-of-band mechanisms | no | N/A | None used. |
| V6.8.1 | 2 | Identities from several IdPs cannot be spoofed | yes | met | Users are unique on `(idp, idp_subject)` with namespaced idps; an email never moves an account between identities (`auth/src/identity/policy.ts`). Tests: `auth/test/login-race.ts`, `auth/test/identity.test.ts`. Accepted: a pre-created unbound user binds at its first verified sign-in from any enabled IdP (T14). |
| V6.8.2 | 2 | Signatures on assertions verified | yes | met | `jose` `jwtVerify` with an asymmetric allow-list; `none` and HMAC refused; keys from the issuer's JWKS (`auth/src/identity/jwt.ts`). Tests: `auth/test/p4-review-signin.test.ts` (key confusion), `auth/test/identity.test.ts` |
| V6.8.3 | 2 | SAML assertions used once | no | N/A | No SAML. |
| V6.8.4 | 2 | Expected authentication strength from the IdP verified | yes | partial | The ID token must be at most 10 minutes old. Sensitive admin actions need a relic-bridge sign-in from the last `RB_SESSION_REAUTH_MINUTES` (P8-73, see V7.5.1). Gap: no `acr` / `amr` / `max_age` is requested or checked, so the strength of the IdP's own authentication is not verified and a live IdP session may answer without a prompt ([admin access](../guide/admin-access.md#re-authentication-for-sensitive-actions)). Possible follow-up: `prompt=login` / `max_age=0` with an `auth_time` check for OIDC. |

## V7 Session Management

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V7.1.1 | 2 | Timeouts documented and justified | yes | met | Idle 30 min, absolute 12 h, re-authentication 10 min, with the allowed ranges, the reason for each default and the risk of changing it in [admin access, why these timeouts](../guide/admin-access.md#why-these-timeouts). Code: `auth/src/identity/session.ts` (`validateSessionTimeouts`), `auth/src/identity/config.ts`. Tests: `auth/test/session.test.ts` |
| V7.1.2 | 2 | Concurrent sessions documented | yes | met | At most 20 per user, the oldest evicted ([admin access](../guide/admin-access.md)). Test: `auth/test/session.test.ts` |
| V7.1.3 | 2 | Federated session behaviour documented | yes | met | The relic-bridge session is independent of the IdP session, and there is no back-channel or front-channel logout; what follows from that (sign-out, removing a person, no stored IdP tokens) is stated in [identity providers, what is checked](../guide/identity-providers.md#5-what-is-checked-security-notes). Tests: `authz/session-revocation.test.ts` (disabling a user ends their sessions) |
| V7.2.1 | 1 | Session verification on the backend | yes | met | Every request loads the session from storage (`http/src/session.ts`). Test: `authz/session-revocation.test.ts` |
| V7.2.2 | 1 | Dynamic tokens, not static secrets | yes | accepted | Sessions and OAuth tokens are generated per sign-in / grant. Per-device `rb_` tokens are long-lived bearer secrets by design (ADR-0009): hash-only, bound to one project, revocable, 90-day default. |
| V7.2.3 | 1 | Reference tokens unique and random (≥ 128 bits) | yes | met | Session secret 256 bits (`auth/src/identity/login.ts` `randomValue`); `rb_` tokens 256 bits; provider tokens 192 bits. Tests: `auth/test/session.test.ts`, `auth/test/tokens.test.ts`, `auth/test/fuzz.test.ts` |
| V7.2.4 | 1 | New session token at authentication | yes | met | Sign-in revokes the previous cookie session and creates a new one. Test: `http/test/p4-review-sessions.test.ts` ("sign-in rotates") |
| V7.3.1 | 2 | Inactivity timeout | yes | met | 30 min default, 5 min–24 h. Tests: `auth/test/session.test.ts`, `http/test/p4-review-sessions.test.ts` |
| V7.3.2 | 2 | Absolute lifetime | yes | met | 12 h default, 1 h–7 days. Same tests. |
| V7.4.1 | 1 | Terminated sessions cannot be reused | yes | met | Logout deletes the session rows; RFC 7009 and device revocation for OAuth. Tests: `authz/routes.test.ts`, `auth/test/session.test.ts`, `authz/oauth-lifecycle-suite.ts` |
| V7.4.2 | 1 | Sessions end when an account is disabled | yes | met | Disable and role change revoke sessions and OAuth devices; `rb_` tokens are refused for a disabled user. Tests: `authz/session-revocation.test.ts`, `authz/oauth-lifecycle-suite.ts` |
| V7.4.3 | 2 | Option to end other sessions after a factor change | no | N/A | No factors held by relic-bridge; a role change already ends every session. |
| V7.4.4 | 2 | Visible logout | yes | met | A sign-out form on every admin page (`ui/src/components.tsx`). Test: `ui/test/components.test.tsx` |
| V7.4.5 | 2 | Administrators can end sessions of one user or all | yes | met | Per user: `POST /users/{id}/sessions/revoke`; for every user: `POST /users/sessions/revoke-all` (administrator, CSRF, recent sign-in, typed phrase; keeps the caller unless `includeSelf`). Code: `http/src/admin/api.ts` (`revokeAllUserSessions`, `requiredRole`, `sensitiveRoute`), `auth/src/identity/session.ts` (`revokeAllSessions`), `http/src/session.ts` (`revokeEverySession`). Tests: `authz/session-hardening.test.ts` (member, administrator, CSRF, cross-site, no session, stale sign-in, wrong phrase, keeps caller, `includeSelf`, admin token), `authz/reauth.test.ts`, `authz/routes.test.ts`, `authz/ui-sessions.test.ts`, `auth/test/session-list.test.ts` |
| V7.5.1 | 2 | Re-authentication before sensitive account changes | yes | met | Sensitive admin changes (master-key rotation, config import, owner setup links, unbind, credential rotation, project deletion, creating or promoting admins and owners, disabling users, signing another user out, long-lived device tokens, OAuth clients and registration) need a sign-in from the last `RB_SESSION_REAUTH_MINUTES` (default 10, 1-60), decided server side from the stored session (`auth/src/identity/session.ts` `sessionIsFresh`; `http/src/admin/api.ts` `sensitiveRoute`, `requireFresh`), plus CSRF, the role and typed or single-use confirmations. A stale session gets one `403 forbidden` / `reauth_required` answer on every route, audited. The admin token is exempt (a secret held outside the browser). Tests: `authz/reauth.test.ts` (one negative case per action, window boundary, client hints ignored, `/me/*` out of scope, UI round trip), `auth/test/session.test.ts`. Limit: the proof is a relic-bridge sign-in; it does not force the IdP to prompt (V6.8.4) |
| V7.5.2 | 2 | Users can view and end their sessions | yes | met | Users can list their active browser sessions and end one or all of them (`/me`), and list and revoke their own OAuth devices (`/me/oauth-devices`). Re-authentication before ending your own session is not required (ending only reduces access; residual noted in THREAT_MODEL). Ending another user's sessions needs a recent sign-in (P8-73). Code: `http/src/admin/api.ts` (`mySessions`, `revokeMySession`), `http/src/session.ts` (`listUserSessions`, `revokeUserSessionByRef`, `coarseClientLabel`), `ui/src/screens/me.tsx`. Tests: `authz/session-hardening.test.ts` (own rows only, another user's id and a prefix of it are 404, no secret in the response, wrong CSRF, admin token `no_user`, idle sessions not listed), `authz/ui-sessions.test.ts`, `ui/test/me.test.ts` (escaping, axe), `auth/test/session-list.test.ts`, `authz/reauth.test.ts` |
| V7.6.1 | 2 | RP / IdP session lifetimes behave as documented | yes | accepted | The relic-bridge session lifetime is independent of the IdP's; re-authentication at the IdP happens at the next sign-in. |
| V7.6.2 | 2 | Session creation needs consent or an explicit action | yes | met | A session is created only after an explicit sign-in start and a callback with single-use, browser-bound state. Test: `http/test/identity.test.ts` |

## V8 Authorization

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V8.1.1 | 1 | Function and data access rules documented | yes | met | [Access model](../guide/access-model.md), [admin access](../guide/admin-access.md) roles, admin API reference. |
| V8.1.2 | 2 | Field-level rules documented | yes | met | One section: [data protection, field-level rules](data-protection.md#field-level-rules) (what each view returns, never returns and to whom). Code: the `*View` functions in `http/src/admin/api.ts`. Tests: `http/test/admin.test.ts` (no key material or token hash in responses), `authz/routes.test.ts` (member audit rows), `authz/member-self-service.test.ts`, `authz/ui-screens.test.ts` |
| V8.2.1 | 1 | Function-level access | yes | met | `requiredRole` on every admin route (`http/src/admin/api.ts`); tools exist only if granted. Tests: `authz/routes.test.ts`, `authz/tools.test.ts` ("ungranted tools") |
| V8.2.2 | 1 | Data-specific access (IDOR) | yes | met | `/me/*` touches own rows only; tokens bound to one project; accounts enforced by `resolveAccounts`; cursors bound to tool, account and filters. Tests: `authz/member-self-service.test.ts`, `authz/tools.test.ts` (foreign accounts, forged cursors) |
| V8.2.3 | 2 | Field-level access | yes | met | Responses never carry ciphertext, hashes or secrets; tools drop out-of-scope rows; bodies ignore ownership fields. Tests: `http/test/admin.test.ts`, `authz/` leak scan, `authz/member-self-service.test.ts` |
| V8.3.1 | 1 | Authorization on the trusted layer | yes | met | All checks in server middleware and handlers; the panel is SSR. Tests: `authz/ui-role-parity.test.ts`, `authz/routes.test.ts` |
| V8.4.1 | 2 | Cross-tenant controls | yes | met | Projects and users isolated: per-request `ToolContext` (T21), caches scoped by grant and credential (T16), RFC 8707 audience per project (T2). Tests: `authz/isolation.test.ts`, `authz/oauth-suite.ts` |

## V9 Self-contained Tokens

relic-bridge issues no JWTs; it verifies IdP ID tokens and Cloudflare Access assertions.

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V9.1.1 | 1 | Signature or MAC verified before use | yes | met | `jwtVerify` before any claim is read (`auth/src/identity/jwt.ts`). Tests: `auth/test/p4-review-signin.test.ts`, `auth/test/identity.test.ts` |
| V9.1.2 | 1 | Algorithm allow-list | yes | met | Asymmetric allow-list intersected with the IdP's advertised set; Access is RS256 only. Test: `auth/test/identity.test.ts` |
| V9.1.3 | 1 | Keys from trusted, pre-configured sources | yes | met | JWKS from the configured issuer's discovery (exact issuer, https) or the fixed Access team domain; `jku` / `jwk` headers ignored. Test: `auth/test/p4-review-signin.test.ts` |
| V9.2.1 | 1 | Validity period enforced | yes | met | `exp`, `iat`, `iss` required, 60 s skew, ID token at most 10 min old. Test: `auth/test/identity.test.ts` |
| V9.2.2 | 2 | Token type checked | yes | met | ID tokens need the transaction nonce and `azp`; Access assertions need `type === 'app'`. Tests: `auth/test/identity.test.ts`, `auth/test/p4-review-signin.test.ts` |
| V9.2.3 | 2 | Audience checked | yes | met | `aud` must be the client id (plus `azp`) or the Access AUD tag. Test: `auth/test/identity.test.ts` |
| V9.2.4 | 2 | Issuer keys per audience | no | N/A | No JWTs are issued. |

## V10 OAuth and OIDC

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V10.1.1 | 2 | Tokens only to components that need them | yes | met | The GitHub user token is revoked after the lookup and never stored; OAuth tokens are accepted only on the MCP route; the browser holds an opaque `HttpOnly` cookie; New Relic keys never leave the server (T12). Test: `auth/test/identity.test.ts` |
| V10.1.2 | 2 | Client accepts AS values only for its own transaction | yes | met | The sign-in transaction is single-use and bound to the provider, the browser cookie, the PKCE verifier and the nonce. Tests: `auth/test/identity.test.ts`, `http/test/identity.test.ts` (provider mix-up) |
| V10.2.1 | 2 | Client CSRF protection (state / PKCE) | yes | met | 256-bit hashed single-use state, `__Host-rb_login` binding cookie, PKCE S256 and nonce. Tests: `http/test/identity.test.ts`, `auth/test/p4-review-signin.test.ts`, `auth/test/fuzz.test.ts` (PKCE) |
| V10.2.2 | 2 | Mix-up defence with several authorization servers | yes | met | The callback's provider must equal the transaction's; discovery issuer must equal the configured issuer; RFC 9207 `iss` required when advertised. Test: `auth/test/p4-review-signin.test.ts` (issuer mix-up) |
| V10.3.1 | 2 | Resource server checks the audience | yes | met | `validateToken(resource)` plus `audience === {issuer}/p/{slug}/mcp` (`http/src/oauth/server.ts` `authenticate`). Tests: `authz/oauth-suite.ts` (RFC 8707, cross-slug), `http/test/fuzz-http.test.ts` |
| V10.3.2 | 2 | Decisions from delegated claims | yes | met | Token props feed `resolveAccess` (tools, accounts, limits); `mcp:read` required; `mcp:write` gates write tools. Tests: `authz/oauth-suite.ts`, `authz/write-scope.test.ts` |
| V10.3.3 | 2 | User identified by a non-reassignable id | yes | met | The provider token's user id is `users.id`; props must match it; email never authorizes. Test: `authz/oauth-suite.ts` |
| V10.3.4 | 2 | Authentication strength in access tokens | no | N/A | MCP tokens carry no authentication-strength requirement. |
| V10.4.1 | 1 | Redirect URIs from a per-client allow-list, exact match | yes | accepted | Exact string match except RFC 8252 §7.3 loopback URIs, which may use any port (the provider's `isValidRedirectUri`); metadata-document clients keep only https URIs on their own host plus loopback. Tests: `authz/oauth-suite.ts` (no open redirect, Claude Code loopback), `http/test/fuzz-http.test.ts` (mutated `redirect_uri`) |
| V10.4.2 | 1 | Codes single use; replay revokes | yes | met | `oauth-code:<sha256>` marker taken atomically before the provider sees the code; a replay revokes the grant. Tests: `authz/oauth-suite.ts` ("a code works once", concurrent redemptions), `http/test/fuzz-http.test.ts` |
| V10.4.3 | 1 | Codes short-lived (≤ 10 min) | yes | met | `OAUTH_CODE_TTL_S = 600`; a wrong verifier burns the code. Test: `authz/oauth-suite.ts` |
| V10.4.4 | 1 | Only the grants a client needs | yes | met | `authorization_code` and `refresh_token` only (no implicit, password or token exchange); client grant types validated. Test: `authz/oauth-suite.ts` (metadata) |
| V10.4.5 | 1 | Refresh token replay mitigated for public clients | yes | met | Single-use rotation with family revocation on reuse, plus a bounded reuse interval (ADR-0013); no sender-constraining (DPoP). Tests: `authz/oauth-lifecycle-suite.ts` |
| V10.4.6 | 2 | PKCE for the code grant | yes | met | S256 required for every client, `plain` removed; verifier syntax checked before the code is consumed. Tests: `authz/oauth-suite.ts`, `http/test/fuzz-http.test.ts` |
| V10.4.7 | 2 | Unauthenticated dynamic registration mitigated | yes | met | Redirect URI and name policy (`http/src/oauth/clients.ts` `checkRegistration`), registration caps, 24 h expiry of unused registrations, a runtime off switch, "not verified" on the consent screen. Tests: `authz/oauth-suite.ts`, `authz/oauth-clients-suite.ts`, `http/test/fuzz.test.ts`, `http/test/fuzz-http.test.ts` |
| V10.4.8 | 2 | Refresh tokens have an absolute expiry | yes | met | 30 days default, not extended by refresh, capped at the grant's expiry. Test: `authz/oauth-lifecycle-suite.ts` |
| V10.4.9 | 2 | Users can revoke refresh and access tokens | yes | met | Device revocation in the panel and `/me/oauth-devices/{id}/revoke`; owners remove clients; RFC 7009. Tests: `authz/oauth-lifecycle-suite.ts`, `authz/ui-oauth-devices.test.ts` |
| V10.4.10 | 2 | Confidential clients authenticate on back-channel requests | yes | met | `client_secret_basic` / `client_secret_post` (secret hashed) at the token and revocation endpoints; public clients use `none` + PKCE. Tests: `http/test/oauth-refresh-replay.test.ts`, `authz/oauth-lifecycle-suite.ts` |
| V10.4.11 | 2 | Only required scopes assigned | yes | met | `mcp:read` and `offline_access`; `mcp:write` only when the deployment enables write tools, in a separate unticked box, never remembered. Tests: `authz/write-scope.test.ts`, `authz/consent-suite.ts` |
| V10.5.1 | 2 | ID token replay mitigated (nonce) | yes | met | 256-bit nonce in the transaction, compared in constant time (`auth/src/identity/oidc.ts`). Test: `auth/test/identity.test.ts` |
| V10.5.2 | 2 | User identified by `sub` | yes | met | Identity is `(idp, sub)` (GitHub: numeric id); email links an unbound row once. Test: `auth/test/identity.test.ts` |
| V10.5.3 | 2 | Malicious AS impersonation refused | yes | met | Discovery issuer equals the configured issuer; endpoints https; callback `iss` checked. Tests: `auth/test/identity.test.ts`, `auth/test/p4-review-signin.test.ts` |
| V10.5.4 | 2 | ID token audience | yes | met | `aud` = client id; `azp` checked when present or with several audiences. Test: `auth/test/identity.test.ts` |
| V10.5.5 | 2 | Back-channel logout DoS | no | N/A | No OIDC back-channel logout. |
| V10.6.1 | 2 | OP response types | no | N/A | relic-bridge is an OAuth authorization server, not an OpenID Provider (no ID tokens; `code` only). |
| V10.6.2 | 2 | OP forced-logout DoS | no | N/A | No OIDC logout endpoints. |
| V10.7.1 | 2 | Consent for each request (always for unassured clients) | yes | met | Consent per authorization request (`http/src/oauth/consent.ts`); an opt-in "don't ask again" (30 days, per user, client, redirect URI and resource; never for `mcp:write`) that is offered and honoured only for client ID metadata-document clients (P8-65, `remembersClient`). A forged `remember=1` from a dynamic client is not saved, and a stored approval of a dynamic client is ignored, deleted and not listed. Tests: `authz/consent-suite.ts` ("P8-65: a dynamically registered client is never offered, saved or answered from memory"; "a remembered approval stored for a dynamic client before the change is ignored, dropped and not listed") |
| V10.7.2 | 2 | Consent shows enough information | yes | met | Escaped client name, the vouching host or "not verified", the redirect host, a loopback warning, the project, tools and accounts (`ui/src/consent.tsx`). Tests: `authz/consent-suite.ts`, `ui/test/consent.test.tsx` |
| V10.7.3 | 2 | Users can review and revoke consents | yes | met | `/oauth/approvals` list and forget; connected apps in `/admin/me`; owners remove clients. Tests: `authz/consent-suite.ts`, `authz/oauth-lifecycle-suite.ts` |

## V11 Cryptography

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V11.1.1 | 2 | Key management policy and lifecycle | yes | met | [Cryptographic inventory](cryptography.md#long-lived-keys-and-secrets): source, storage, recommended cryptoperiod (with the NIST SP 800-57 reference), rotation and compromise procedure for every long-lived key; operational steps in [secrets](../guide/secrets.md) and ADR-0007. Rotation is an operator action, nothing expires on its own. |
| V11.1.2 | 2 | Cryptographic inventory | yes | met | [Cryptographic inventory](cryptography.md): every key, algorithm, KDF, MAC, hash and random source with its file, what it protects and where it is stored, verified against the code. Test: `scripts/test/crypto-inventory.test.ts` (fails when a file uses a primitive or names an algorithm the inventory lacks) |
| V11.2.1 | 2 | Industry-validated implementations | yes | met | WebCrypto, `jose` and the Cloudflare OAuth provider only (plus `node:crypto` in Node-only tooling); the only custom routines are the CRC-32 typo checksum of `rb_` tokens (not a security primitive) and the constant-time comparison `timingSafeEqual`. Test: `auth/test/kat.test.ts` (NIST AES-GCM vectors) |
| V11.2.2 | 2 | Crypto agility | yes | partial | Formats are versioned (master key `v<N>:`, envelope versions, KDF parameters in the bundle, HKDF info labels), so migration is possible. Gap: algorithms are fixed constants, not configuration. |
| V11.2.3 | 2 | ≥ 128-bit security | yes | met | AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, PBKDF2-SHA-256 (≥ 600 000), SHA-256. Tests: `auth/test/kat.test.ts`, `auth/test/keyring.test.ts` |
| V11.3.1 | 1 | No ECB, no PKCS#1 v1.5 encryption | yes | met | AES-GCM only; RS256 is used only to verify IdP signatures. |
| V11.3.2 | 1 | Approved ciphers and modes | yes | met | AES-256-GCM, random 96-bit IV, 128-bit tag (keyring, transfer seal, refresh replay records, query cache, task records); the OAuth provider's grant props use AES-256-GCM with a fresh key per encryption (fixed IV) and AES-KW key wrapping ([inventory](cryptography.md#oauth-authorization-server)). Tests: `auth/test/kat.test.ts`, `auth/test/keyring.test.ts` |
| V11.3.3 | 2 | Authenticated encryption | yes | met | AEAD everywhere with injective AAD (credential id + version; bundle KDF parameters and credential metadata; task owner). Tests: `auth/test/keyring.test.ts` (bit flips, AAD swap), `http/test/oauth-refresh-replay.test.ts`, `auth/test/config-transfer.test.ts` |
| V11.4.1 | 1 | Approved hash functions | yes | met | SHA-256, HMAC-SHA-256, HKDF-SHA-256 only; no MD5 or SHA-1. |
| V11.4.2 | 2 | Password storage KDF | no | N/A | No passwords; `rb_` tokens are SHA-256 of 256-bit random values (ADR-0007). |
| V11.4.3 | 2 | Collision-resistant hashes for integrity | yes | met | SHA-256 for token, session and identity hashes and cache ids. |
| V11.4.4 | 2 | Key stretching when deriving keys from passwords | yes | met | PBKDF2-HMAC-SHA-256, ≥ 600 000 iterations, 16-byte salt for config-bundle passphrases (`auth/src/transfer/seal.ts`). Test: `auth/test/config-transfer.test.ts` |
| V11.5.1 | 2 | CSPRNG for non-guessable values | yes | met | `crypto.getRandomValues` / `randomUUID` (or `node:crypto` `randomBytes` in Node tooling) for every secret and id (sessions, state, nonce, tokens by rejection sampling, setup links, task ids, OTLP ids); `Math.random` only for trace sampling, retry jitter and picking which of a user's own form handles to reuse ([inventory](cryptography.md#random-sources)). Tests: `auth/test/tokens.test.ts`, `scripts/test/crypto-inventory.test.ts` |
| V11.6.1 | 2 | Approved algorithms for key generation | yes | met | No asymmetric keys are generated; signatures are only verified (allow-listed). |

## V12 Secure Communication

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V12.1.1 | 1 | TLS 1.2 / 1.3 only | yes | partial | `serve` speaks plain HTTP by design and documents a TLS proxy for anything beyond the machine ([self-hosting](../guide/self-hosting.md), `deploy/Caddyfile`); the Worker is HTTPS through Cloudflare. Gap: the app cannot enforce TLS versions itself. |
| V12.1.2 | 2 | Recommended cipher suites | yes | accepted | Cipher suites belong to the hosting layer (Caddy, Cloudflare) and the runtime for outbound calls. |
| V12.1.3 | 2 | mTLS client certificates | no | N/A | No mTLS. |
| V12.2.1 | 1 | TLS for all external connectivity | yes | met | Worker HTTPS-only; `serve` binds loopback by default, needs `RB_ALLOWED_HOSTS` otherwise, pass-through refuses plain HTTP off loopback, HSTS (V3.4.1). Test: `http/test/passthrough.test.ts` |
| V12.2.2 | 1 | Publicly trusted certificates | yes | accepted | Certificates come from the hosting layer (ACME via Caddy, Cloudflare). |
| V12.3.1 | 2 | Encrypted inbound and outbound connections | yes | met | Outbound https only: fixed NerdGraph endpoints, IdP issuers, OTLP endpoint (loopback excepted), metadata documents. Tests: `http/test/telemetry.test.ts`, `http/test/fuzz.test.ts` (OTLP endpoint) |
| V12.3.2 | 2 | TLS certificates validated | yes | met | Platform verification everywhere; no `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED`. |
| V12.3.3–V12.3.4 | 2 | TLS between internal services | no | N/A | No internal services: the panel calls the admin API in process; storage is a local file or a platform binding. |

## V13 Configuration

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V13.1.1 | 2 | Communication needs documented | yes | met | One list: [data protection, outbound destinations](data-protection.md#outbound-destinations) (NerdGraph regions, IdP and JWKS, metadata documents, OTLP, `doctor`, `--remote`), with what is sent, the credential and the redirect rule. Trust boundaries in THREAT_MODEL section 1, [OAuth how it works](../guide/oauth-how-it-works.md), [observability](../guide/observability.md). Tests: `core/test/nerdgraph-client.test.ts` (redirect refused), `http/test/telemetry.test.ts`, `authz/oauth-clients-suite.ts` |
| V13.2.1 | 2 | Backend credentials not static where avoidable | yes | accepted | New Relic accepts only static User API keys; the admin token is static (hashed compare, strength-checked). Device and OAuth tokens are per device and revocable. |
| V13.2.2 | 2 | Least privilege for backend communication | yes | met | Dedicated User key recommended ([security basics](../guide/security-basics.md)); Docker non-root, read-only root; database `0600`; keys scoped per grant. Test: `packages/storage-sqlite/test/sqlite.test.ts` |
| V13.2.3 | 2 | No default credentials | yes | met | Master key required; weak or placeholder admin tokens refused (`http/src/admin/token.ts`). Test: `http/test/admin-token.test.ts` |
| V13.2.4 | 2 | Allow-list of external resources | yes | met | NerdGraph is a fixed region list; DCR redirect hosts can be allow-listed (`RB_OAUTH_DCR_REDIRECT_HOSTS`); metadata-document hosts can be allow-listed with `RB_OAUTH_CIMD_HOSTS` (opt-in; when unset the fetch stays guarded: any public https host, port 443, no redirects, budgeted). A host outside the list is not fetched and is audited as `oauth.client.refused` (host only), on the token endpoint too. Code: `http/src/oauth/settings.ts`, `http/src/oauth/server.ts` (`clientMetadataHosts`, `resolveClient`), `worker/src/env.ts`, `cli/src/args.ts`. Tests: `authz/oauth-suite.ts` ("RB_OAUTH_CIMD_HOSTS (P8-96)", "narrowing ... cached"), `cli/test/serve-identity.test.ts` |
| V13.2.5 | 2 | Server allow-list for outbound access | yes | accepted | No egress firewall in the app; Node checks every resolved address at connect time for caller-named URLs, Workers use `global_fetch_strictly_public`. Test: `cli/test/cimd-fetch.test.ts` |
| V13.3.1 | 2 | Secrets management solution | yes | partial | Master key from a secret store, a `0600` file, the OS keychain or Worker secrets; versioned rotation ([secrets](../guide/secrets.md), `cli/src/keychain.ts`). Gap: no vault / HSM integration (an L3 expectation). |
| V13.3.2 | 2 | Least privilege for secrets | yes | met | Key files must be `0600`; New Relic keys decrypted per request inside `NerdGraphClient`; never in tool arguments (T23). Tests: `cli/test/doctor.test.ts`, `core/test/registry.test.ts` |
| V13.4.1 | 1 | No source control metadata deployed | yes | met | Docker build context is an allow-list (`.dockerignore`); the npm package ships `dist` only (`scripts/check-package.ts`). |
| V13.4.2 | 2 | Debug modes off | yes | met | No debug endpoints or stack traces in responses; test hooks compiled out of releases. Test: `cli/test/test-hooks.test.ts` |
| V13.4.3 | 2 | No directory listings | yes | met | No filesystem is served; assets are embedded with hashed names. |
| V13.4.4 | 2 | No HTTP TRACE | yes | met | Unrouted methods (TRACE included) get `404` from the router. |
| V13.4.5 | 2 | Documentation and monitoring endpoints not exposed | yes | met | `/health` and `/version` are minimal; the admin OpenAPI document is behind admin auth; the public tool catalog is opt-in. Tests: `authz/public-catalog.test.ts`, `http/test/admin-docs.test.ts` |

## V14 Data Protection

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V14.1.1 | 2 | Sensitive data identified and classified | yes | met | THREAT_MODEL section 2 (assets and sensitivity). |
| V14.1.2 | 2 | Protection requirements per level | yes | met | One table per class of data (where it lives, encryption, retention, logging): [data protection by class](data-protection.md#data-protection-by-class), with [cryptography](cryptography.md) and [logging](logging.md) for detail; also [secrets](../guide/secrets.md), [audit log](../guide/audit-log.md), [query cache](../guide/query-cache.md), T7 / T8 / T17 |
| V14.2.1 | 1 | Sensitive data only in bodies or headers | yes | met | Keys in bodies or headers, tokens in `Authorization`, one-time tokens in a body. In URLs only the single-use, hashed, expiring setup code and the standard OAuth `code` / `state` (with a same-origin referrer policy and no third-party resources). |
| V14.2.2 | 2 | No sensitive data in server caches | yes | met | Query cache TTL-bound, bounded, HMAC-keyed and scoped; Workers Cache API bodies encrypted (T16); `Cache-Control: no-store` on responses. Test: `core/test/query-cache.test.ts` |
| V14.2.3 | 2 | No sensitive data to untrusted parties | yes | met | No trackers or third-party resources (CSP); OTLP export opt-in and allow-listed (T30). Test: `http/test/telemetry.test.ts` |
| V14.2.4 | 2 | Encryption, retention and handling controls implemented | yes | met | Hashed tokens, AES-256-GCM keys, redacted logs and audit, 90-day audit retention with purge, NRQL masking. Tests: `core/test/redact.test.ts`, `http/test/audit.test.ts` |
| V14.3.1 | 1 | Client storage cleared at logout | yes | met | No client storage is used; logout revokes the server session, clears the cookie and sends `Clear-Site-Data: "cookies", "storage"` (not on a refused sign-out). Code: `http/src/identity.ts` (`CLEAR_SITE_DATA`, `toLogin`). Test: `authz/routes.test.ts` "sign-out (P4-02)": present on a sign-out and on an expired-session sign-out, absent on a refused one and on a cookie-less cross-site form |
| V14.3.2 | 2 | Anti-caching headers | yes | met | `Cache-Control: no-store` on every response except hashed static assets. Tests: `http/test/app.test.ts`, `http/test/p4-consolidation-owner-assets.test.ts` |
| V14.3.3 | 2 | No sensitive data in browser storage | yes | met | No `localStorage`, `sessionStorage` or IndexedDB; cookies hold only the session id, a sign-in binding value and a fixed flash code. |

## V15 Secure Coding and Architecture

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V15.1.1 | 1 | Remediation time frames for third-party components | yes | met | [SECURITY.md](../../SECURITY.md) sets response targets for vulnerabilities in relic-bridge and, in "Advisories in third-party components", time frames per severity (critical 7 days, high 14, moderate 30, low next update or 90); Renovate security updates skip the release-age delay. The time frames are a proposal the owner confirms (pending decision P8-95) |
| V15.1.2 | 2 | SBOM / inventory of components | yes | met | Lockfile, exact pins, CycloneDX SBOM in releases and the image attestation, `scripts/check-licenses.ts`. |
| V15.1.3 | 2 | Resource-heavy functionality documented | yes | met | [Query limits](../guide/query-limits.md), [Cloudflare limits](../guide/cloudflare-limits.md), [query cache](../guide/query-cache.md), ARCHITECTURE (budgets, semaphore, caps). |
| V15.2.1 | 1 | Components within the remediation policy | yes | met | `pnpm audit --audit-level high`, dependency review (`fail-on-severity: high`) and the Docker image scan (high and critical) gate CI; SECURITY.md states that moderate and low advisories are not gated and are fixed within their time frames through Renovate and the dependency dashboard (`.github/workflows/security.yml`, `renovate.json`) |
| V15.2.2 | 2 | Availability defences for heavy functionality | yes | met | Per-credential semaphore, call budget, body caps, request deadline, response caps, rate limits, quotas. Tests: `http/test/stream-deadline.test.ts`, `http/test/rate-limit.test.ts`, `http/test/fuzz-http.test.ts` |
| V15.2.3 | 2 | Only required functionality in production | yes | met | Test hooks compiled out; distroless image; npm package `dist` only; spikes and e2e not shipped. |
| V15.3.1 | 1 | Only required fields returned | yes | met | Admin API builds outputs field by field (masked keys, tokens without hashes); `whoami` returns no key material. Tests: `http/test/admin.test.ts`, `authz/` leak scan |
| V15.3.2 | 2 | Outbound calls do not follow redirects | yes | met | One policy for every outbound client: `redirect: 'manual'` (or `error`) forced through `outboundFetch` (`core/src/outbound.ts`, `noRedirects`); applied in `core/src/nerdgraph/client.ts`, `auth/src/identity/{github,oidc,cf-access}.ts`, `http/src/telemetry.ts`, `cli/src/manage/host.ts`, `cli/src/test-hooks.ts`, `worker/src/cimd-fetch.ts` and `scripts/nerdgraph-schema.ts`; IdP calls already set it (`auth/src/identity/http.ts`, `jwt.ts`); the Node metadata fetcher uses `node:https`. Tests: `scripts/test/outbound-redirects.test.ts` (fails on any source file that calls the global `fetch`; wrapper behaviour; a 302 stays unfollowed), `authz/oauth-suite.ts` CIMD "redirect" case, `cli/test/cimd-fetch.test.ts` |
| V15.3.3 | 2 | Mass assignment | yes | met | `strictObject` schemas reject unknown fields (`http/src/admin/schemas.ts`, import schema). Tests: `http/test/admin.test.ts`, `authz/admin-management.test.ts` |
| V15.3.4 | 2 | Client IP passed and trusted correctly | yes | met | See V4.1.3; IPv6 bucketed per /64; boot warning when `X-Forwarded-For` arrives with hops 0. Tests: `http/test/rate-limit.test.ts`, `http/test/fuzz.test.ts` |
| V15.3.5 | 2 | Types and strict comparisons | yes | met | Strict TypeScript and zod on all inputs; constant-time compares for secrets. |
| V15.3.6 | 2 | Prototype pollution | yes | met | Own-key checks (`Object.hasOwn`) and `Object.fromEntries` where input becomes an object. Tests: `core/test/output.test.ts` (`__proto__` attribute), `scripts/test/chart-app.test.ts` |
| V15.3.7 | 2 | HTTP parameter pollution | yes | met | Repeated parameters refused on the admin API and OAuth endpoints; exactly one CSRF field. Tests: `http/test/admin.test.ts`, `authz/oauth-suite.ts`, `http/test/fuzz-http.test.ts` (duplicated parameters) |

## V16 Security Logging and Error Handling

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V16.1.1 | 2 | Logging inventory | yes | met | [Logging inventory](logging.md): each sink (stderr / Workers Logs, audit table, OTLP) with its fields, format, redaction, retention, readers and the ASVS V16.3 event coverage, verified against the code; gaps tracked in P8-85. |
| V16.2.1 | 2 | Log metadata (when, where, who, what) | yes | met | JSON lines with time, level, request id, route, status, principal, token and grant ids; audit rows carry the actor. Tests: `http/test/app.test.ts`, `http/test/audit.test.ts` |
| V16.2.2 | 2 | Synchronized time, UTC timestamps | yes | met | ISO 8601 UTC in the logger (`core/src/logger.ts`); clock sync is the platform's. |
| V16.2.3 | 2 | Logs only to documented sinks | yes | met | stderr (Workers Logs on Cloudflare), the audit table and opt-in OTLP, listed in the [logging inventory](logging.md#sinks-at-a-glance); product code logs only through `console.error`, and the CLI sends third-party `console.log` / `console.info` output to stderr too (`cli/src/index.ts`). |
| V16.2.4 | 2 | Machine-readable logs | yes | met | Structured JSON, one line each; OTLP export allow-listed. |
| V16.2.5 | 2 | Sensitive data logged per protection level | yes | met | Mandatory redaction in the logger; audit stores no tokens and masks NRQL by default (T8). Tests: `core/test/redact.test.ts`, `core/test/logger.test.ts`, `http/test/audit.test.ts` |
| V16.3.1 | 2 | Authentication events logged | yes | met | `auth.denied`, `login.ok` / `login.denied`, session events, admin-token failures; token issuance: OAuth code exchange and refresh write `oauth.token.issue` and `oauth.token.refresh` (`http/src/oauth/server.ts`, `checkIssuance`); session expiry is logged as `auth.denied` with `session_idle` / `session_expired`; the retention purge run by `serve` records `audit.purge` with `source: schedule`. Tests: `http/test/audit.test.ts`, `auth/test/p4-review-signin.test.ts`, `authz/oauth-lifecycle-suite.ts` ("successful issuance is audited"; memory, SQLite, D1), `authz/session-expiry-audit.test.ts`, `cli/test/serve-e2e.test.ts` |
| V16.3.2 | 2 | Failed authorization logged | yes | met | `admin.forbidden`, `request.rejected`, `tool.not_granted`, `quota.denied`. Tests: `authz/ui-role-parity.test.ts`, `authz/routes.test.ts` |
| V16.3.3 | 2 | Documented security events and bypass attempts | yes | met | Rate-limit, size, batch, Host / Origin, CSRF and validation refusals logged (`reject`), audit refusals recorded. Test: `http/test/app.test.ts` |
| V16.3.4 | 2 | Unexpected errors and control failures | yes | met | `onError` logs unhandled errors; NerdGraph network errors and storage failures logged; an undecryptable credential writes `credential.decrypt_failed` with the credential id, project and key version, never key material (`http/src/app.ts`). Tests: `core/test/server.test.ts`, `authz/credential-decrypt-audit.test.ts` (also pins the per-minute cap and the T8 scan) |
| V16.4.1 | 2 | Log injection prevented | yes | met | JSON encoding of whole records; CLI output strips control and bidi characters; MCP headers pattern-checked (`safeMcpHeader`). Tests: `core/test/logger.test.ts`, `http/test/fuzz.test.ts` |
| V16.4.2 | 2 | Logs protected from access and modification | yes | partial | Audit repository is append-only by API, role-gated viewer, database `0600`. Gap: no tamper evidence; stderr protection is the operator's. |
| V16.4.3 | 2 | Logs sent to a separate system | yes | partial | Opt-in OTLP and Workers Logs; stderr can be shipped by the operator. Gap: no default separate sink; the audit table lives in the application database. |
| V16.5.1 | 2 | Generic error messages | yes | met | `{"error":"internal_error"}` with a request id; tool errors map unknown errors to `RB_INTERNAL`. Tests: `core/test/errors.test.ts`, `core/test/server.test.ts` |
| V16.5.2 | 2 | Secure operation when external resources fail | yes | met | Retries within budget; a cache failure is a miss; audit write failures never surface; storage failure answers 503. Tests: `http/test/app.test.ts`, `worker/test/worker.test.ts` |
| V16.5.3 | 2 | Fail securely (no fail-open) | yes | met | Authentication and authorization fail closed; writes fail closed when the audit intent or the limiter fails. The general rate limiter fails open and logs (an availability control, not an authorization one). |

## V17 WebRTC

| Id | L | Topic | Applies | Status | Evidence |
|---|---|---|---|---|---|
| V17.1.1 | 2 | TURN server | no | N/A | relic-bridge uses no WebRTC. |
| V17.2.1–V17.2.4 | 2 | Media (DTLS, SRTP) | no | N/A | No WebRTC. |
| V17.3.1–V17.3.2 | 2 | Signaling server | no | N/A | No WebRTC. |

## Open items

The partial items, grouped. Each is a candidate for a task; none is a known vulnerability. P8-95 closed the
documentation items (V7.1.1, V7.1.3, V8.1.2, V13.1.1, V14.1.2, V15.1.1, V15.2.1) and the product items that had been
fixed since (V3.4.1, V7.5.1, V10.7.1).

- **Product**: IdP-asserted authentication strength or a forced IdP prompt on step-up (V6.3.3, V6.8.4). P8-96 closed
  V7.4.5 (end every user's sessions), V7.5.2 (list and end your own sessions), V14.3.1 (`Clear-Site-Data` on logout),
  V15.3.2 (one outbound redirect policy) and V13.2.4 (`RB_OAUTH_CIMD_HOSTS`, an opt-in host allow-list); P8-85 closed
  the evidence gaps for V16.3.1 and V16.3.4 (token issuance, undecryptable credentials and the scheduled purge are audited).
- **Platform or design** (recorded, no change planned): all-or-nothing multi-row admin operations on D1 (V2.3.3); TLS
  versions and certificates at the hosting layer (V12.1.1); vault / HSM integration (V13.3.1); tamper-evident and
  off-host logs by default (V16.4.2, V16.4.3); crypto agility beyond versioned formats (V11.2.2).
