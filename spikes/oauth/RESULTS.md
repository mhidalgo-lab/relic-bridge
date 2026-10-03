# P0-08 results: OAuth 2.1 server on Workers and Node, per-slug resources

Date: 2026-10-01. Versions: `@cloudflare/workers-oauth-provider` **1.2.1**, `@modelcontextprotocol/server` 2.2.0,
wrangler 4.143.0 (workerd 1.20260926.1), Node 24.16.0. Everything ran locally; nothing was deployed (see
[deploy-and-test.md](deploy-and-test.md) for the real-client step).

**Verdict: go.** Provider 1.2.x implements the MCP 2026-07-28 authorization profile natively, including multiple
resources with one audience each. It runs on Node *unmodified* with two small adapters. RESEARCH.md §5 described an
older 0.x-style API and is now out of date: 1.x has split `OAuthAuthorizationServer` / `OAuthResourceServer` roles.

## 1. Requirements

| # | Requirement | Result | How / evidence |
|---|---|---|---|
| a1 | RFC 9728 Protected Resource Metadata **per path** (`/.well-known/oauth-protected-resource/p/{slug}/mcp`) | ✅ native | `OAuthResourceServer` serves it for its `resource`; distinct documents for `a` and `b` (e2e checks 3–4) |
| a2 | `WWW-Authenticate` `resource_metadata` hint on 401 | ✅ native | `Bearer realm="OAuth", resource_metadata="…/p/a/mcp", scope="mcp:read"` (e2e 1–2). Satisfies Claude's "401 + pointer" requirement |
| b | RFC 8707 audience binding: token for `/p/a/mcp` **rejected** at `/p/b/mcp` | ✅ native | Each grant/token is bound to exactly one registered resource; the resource server refuses other audiences → 401 (e2e 15). Refresh **cannot retarget** (`invalid_target`, e2e 18); unknown resource at authorize → `invalid_target` (e2e 21). We keep a one-line defence-in-depth check (`props.projectSlug === slug`) in our handler |
| c1 | DCR (RFC 7591) | ✅ native | `clientRegistrationEndpoint`; public client registered (201). 90-day TTL that renews while in use |
| c2 | CIMD | ✅ native on Workers | Verified with **Claude Code's real document** (`https://claude.ai/oauth/claude-code-client-metadata`), loopback redirect on any port for both `127.0.0.1` and `localhost`; foreign redirect refused (`scripts/cimd.ts`). Needs `compatibility_flags: ["global_fetch_strictly_public"]` (SSRF protection). `http://` client ids are refused (HTTPS-only by the draft), so local testing must use a real https document |
| c3 | PKCE S256 only | ✅ native | Metadata `["S256"]`; `plain` and missing PKCE refused for public clients (e2e 22–23) |
| c4 | RFC 9207 `iss` in authorization responses | ✅ native | Always on; also in error redirects (e2e 11, 21) |
| c5 | Refresh rotation, revocation (RFC 7009) | ✅ native | Refresh rotates (previous token valid until the new one is used); revoked token → 401 (e2e 19–20, 28–29) |
| — | Dynamic project list | ✅ with pattern | `resources` is fixed per `OAuthAuthorizationServer` instance, so we **construct the AS + resource servers per request** from the current project list (cheap; all state is in KV). A project added at runtime worked immediately, and existing tokens kept working (e2e 24–26) |
| — | MCP SDK v2 behind the resource server | ✅ | `createMcpHandler(factory, { legacy: 'stateless' })` inside the resource handler; the factory receives the grant (`ctx.props`), so tools can be filtered per grant |

The automated suite (`scripts/e2e.ts`, 29 checks) passes on **workerd** and on **Node**. `scripts/cimd.ts` passes on both
(Node with `NODE_CIMD=1`).

## 2. Node portability

**Verdict: works unmodified**, with three host adapters and no fork or patch of the library:

1. **`cloudflare:workers` import.** The bundle statically imports `WorkerEntrypoint`, which it uses only for `instanceof`
   checks on class-based handlers. On Node, a resolve hook (`src/node-register.ts`) maps the specifier to a 10-line shim.
   In the real CLI this is a bundler alias (tsdown/rolldown `alias`) rather than a runtime hook.
2. **KV.** It uses only `get(key, {type:'json'|'text'})`, `put(key, value, {expiration | expirationTtl, metadata})`,
   `delete`, and `list({prefix, limit, cursor})` with key `metadata`. `src/kv-sqlite.ts` (≈80 lines over `node:sqlite`)
   implements them, including TTL semantics (60 s minimum, like Cloudflare). In production this becomes a table in the
   project's SQLite DB (ADR-0006) and must pass a KV contract test suite.
3. **CIMD SSRF guard.** The provider enables CIMD only when `Cloudflare.compatibilityFlags.global_fetch_strictly_public`
   is true. On Node we install a fetch guard (https only, every resolved address must be public; blocks RFC 1918,
   loopback, link-local/metadata `169.254.169.254`, CGNAT, ULA, multicast, IPv4-mapped) and then set that flag. Verified:
   CIMD flow passes; a client_id on `169.254.169.254` is refused. **The spike guard has a DNS-rebinding TOCTOU gap**
   (it resolves, then fetch resolves again). Production must validate at connect time with an undici `Agent` whose
   `connect.lookup` rejects non-public addresses, used only for CIMD/JWKS fetches. Without that, CIMD stays off on Node and
   DCR is the fallback, which Claude handles automatically.

Not needed on Node: `caches` (the CIMD document cache is skipped when `caches` is undefined), and `ctx.waitUntil` (a
stub is enough; the provider doesn't depend on it for correctness). `oidc-provider` (panva) was therefore **not needed**.
It would bring a second implementation to secure, a different storage model, and only partial MCP-profile fit
(RFC 8707 via its resource-indicators feature, no CIMD), so it isn't recommended.

## 3. Costs on Workers Free (measured with a counting KV, `scripts/kv-ops.ts`)

| Step | KV get | KV put | KV list |
|---|---|---|---|
| DCR registration | 0 | 1 | 0 |
| Authorize + consent (first grant) | 2 | 1 | 1 |
| Code → token | 2 | 2 | 0 |
| **MCP request (token validation)** | **1** | 0 | 0 |
| Refresh | 2 | 2 | 0 |

- Each MCP request spends **1 subrequest** on token validation (of 50 on Free). Fine.
- **KV Free = 1,000 writes/day.** Refresh costs 2 writes. With 1 h access tokens and Claude's proactive refresh
  (≤ 5 min before expiry), one active device × project ≈ 48 writes/day; the owner's 4 devices × 2 projects in all-day
  use ≈ 400/day. That fits, but it's the tightest Free-plan limit found so far. Recommendation: access-token TTL
  configurable, default **1 h on Paid, 8 h on Free** (documented trade-off), plus a warning in `whoami` / admin when daily
  writes approach the limit.

## 4. Findings that change other tasks

1. **Per-request construction** of `OAuthAuthorizationServer` / `OAuthResourceServer` from the storage project list
   (P5-01). Cache instances per (origin, projects-version) in the isolate to avoid rebuilding on every request.
2. **Unknown slug**: the spike returns 404; real code must return the same 401 challenge shape as an invalid token (T19).
   The provider can't know unknown slugs, so `http-app` handles it before delegating.
3. **CIMD errors**: `parseAuthRequest`/`lookupClient` throw `CimdFetchError` when the document can't be fetched; the spike's
   `/authorize` let it bubble up as a 500. Real code must render a 400 (P5-03).
4. **Consent page**: use the provider's `beginConsent()` / `approveConsent()` / `isConsentRemembered()` helpers
   (`__Host-` cookies, CSRF built in) instead of writing our own (P5-04). Display the redirect host prominently, with an
   extra warning for loopback-only clients (Claude docs requirement).
5. **Upstream sign-in**: `beginUpstream()` / `finishUpstream()` exist for Google/GitHub as the identity step (P4-01/P5-04),
   so we may not need a separate OIDC client library for the consent flow (admin sessions still need P4-02).
6. **Revocation endpoint = token endpoint** (`/oauth/token`); clients find it via metadata. No action.
7. **Claude specifics** (deploy-and-test.md §2): CIMD is chosen only if `none` is in `token_endpoint_auth_methods_supported`
   (it is); hosted apps redirect to `https://claude.ai/api/mcp/auth_callback`; Claude uses only the first
   `authorization_servers` entry; endpoint latency budget 10 s (30 s refresh). This favours a **single-Worker topology**
   (AS + resources on one origin) rather than split Workers.
8. **Static bearer tokens (P2-05) can coexist**: `OAuthResourceServer.validateToken` is our function, so we can recognise
   `rb_` tokens by prefix and validate them against storage, falling back to the provider (pattern from the provider's
   "alongside your own tokens" docs). One resource server, two credential types.
9. Grants are revoked per (user, client, resource) on re-authorization by default. Per-device grants therefore come
   naturally: each device's client/redirect is distinct (DCR client per device; CIMD scoped by redirect URI).

## 5. Recommended ADR-0009 decision text

> **Phase 5 OAuth implementation.** Use `@cloudflare/workers-oauth-provider` ≥ 1.2 on **both** runtimes, in a
> single-origin topology: one `OAuthAuthorizationServer` (issuer = deployment origin) whose `resources` are the per-project
> URLs `…/p/{slug}/mcp`, and one `OAuthResourceServer` per project, both constructed per request (isolate-cached by project
> list version). Tokens are audience-bound to exactly one project (RFC 8707). Every project publishes its own RFC 9728
> metadata. CIMD (preferred) and DCR (compatibility) are both enabled; PKCE S256 only; RFC 9207 `iss` always.
> Our `validateToken` accepts relic-bridge static `rb_` tokens (P2-05) alongside OAuth tokens.
> On Node, the library runs unmodified with: a bundler alias for `cloudflare:workers`, a KV-compatible table in SQLite
> (verified by a shared KV contract suite), and CIMD enabled only together with a connect-time SSRF guard (undici
> `connect.lookup`); otherwise Node falls back to DCR. `oidc-provider` is rejected (second implementation, no CIMD).

## 6. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Provider is pre-2.0 and moving fast (1.0 → 1.2 changed option names, e.g. `requiredScopes`) | medium | Pin exact version; Renovate with review; our e2e suite (ported from this spike) runs in CI on both runtimes |
| Node path relies on internals staying KV-only and the `cloudflare:workers` import staying `instanceof`-only | medium | KV contract test + Node e2e in CI catch regressions on upgrade |
| KV Free write quota (1,000/day) exhausted by refreshes | low–medium | Longer access TTL on Free; usage warning; recommend Paid for teams |
| CIMD SSRF on Node | medium if done naively | Connect-time guard (undici) or CIMD off on Node |
| Provider stores grant `userId`/`metadata` unencrypted in KV keys/metadata | low | Use opaque user ids (not emails) as `userId`; never put secrets in `metadata` (props are encrypted) |
| Real clients diverge from docs (CIMD vs DCR choice, mobile flow) | medium | deploy-and-test.md must be executed before closing P0-08 (pending) |

## Real-client results

Deployed 2026-10-02 (`relic-bridge-spike-oauth`, KV-backed). **Automated against production:**
- `scripts/cimd.ts`: **ALL CHECKS PASSED** (CIMD with Claude Code's real metadata document, so `global_fetch_strictly_public` works).
- `scripts/e2e.ts`: all OAuth checks pass (DCR, PKCE S256 only, cross-slug rejection, refresh can't retarget, revocation). Two
  expected deviations:
  1. "runtime-added project" passed on one run and failed on another (`invalid_target`). The spike keeps projects in
     **isolate memory**, and production routes requests to different isolates. **Confirms the project list must come from
     storage** (ADR-0009: built per request from stored projects, cached by version).
  2. "CIMD http://localhost client_id refused" fails in production because `BASE` is HTTPS there, so the self-hosted CIMD
     document is legitimately accepted. Test artifact, not a defect.

Manual (maintainer):

| Client + version | Registration used (CIMD/DCR) | Connected? | echo OK? | Refresh seen after 1 h? | Notes |
|---|---|---|---|---|---|
| Claude Code 2.1.287 | CIMD expected (not visible in exported logs) | yes | yes | not observed | Maintainer test, 2026-10-02 |
| GitHub Copilot Desktop | not recorded | yes | yes | not observed | Maintainer test, 2026-10-02 |
| claude.ai web / Claude mobile | — | — | — | — | Custom connectors unavailable on the maintainer's account; deferred to P5-06 |

The test Worker and KV namespace were deleted on 2026-10-03.
