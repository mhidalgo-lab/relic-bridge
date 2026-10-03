# Threat model

> Status: **draft v0** (2026-10-01). Any change to auth, storage, tools with side effects, or network exposure must
> update this file in the same PR. Final review is task P8-01.

## 1. Scope and trust boundaries

```
[Internet] ──TLS──▶ [relic-bridge HTTP edge] ──▶ [core] ──TLS──▶ [NerdGraph]
     ▲                    │        │
     │                    ▼        ▼
[MCP client + LLM]    [storage]  [IdP: Google/GitHub/CF Access]
     ▲
[telemetry content written by third parties: logs, error messages, span names]
```

Trust boundaries:
- **TB1** MCP client → server (authentication and authorization)
- **TB2** server → storage (secrets at rest)
- **TB3** server → NerdGraph (outbound credentials)
- **TB4** admin browser → admin panel
- **TB5** telemetry content → LLM: data returned by tools is **untrusted**
- **TB6** supply chain → build artifacts

## 2. Assets

| Asset | Sensitivity | Notes |
|---|---|---|
| NR User API keys | **critical** | Can read all telemetry the NR user can see; may also allow writes on the NR side. |
| Master encryption key (`RB_MASTER_KEY`) | **critical** | Decrypts all credentials. |
| Access tokens / OAuth tokens / refresh tokens | high | Each one gives access to one project grant. |
| Admin sessions | high | Full control of the instance. |
| Telemetry query results | high | May contain PII, secrets in logs, customer data. |
| Audit log | medium | Contains NRQL (redacted) and usage metadata. |
| Configuration (projects, grants) | medium | Reveals structure; no secrets. |

## 3. Threat actors

1. Unauthenticated internet attacker (remote modes).
2. Authenticated client trying to exceed its grant (other project, tool or account).
3. **Malicious telemetry author**: anyone who can make the monitored apps log text (prompt injection).
4. Malicious or compromised MCP client or OAuth client registration.
5. Rogue or compromised admin.
6. Supply-chain attacker (dependency, GitHub Action, release pipeline).
7. Local malware on a user's device (out of scope beyond token revocation and short token lifetimes).

## 4. Threats and mitigations (STRIDE)

| # | Threat | Category | Mitigation | Task |
|---|---|---|---|---|
| T1 | Brute-forcing or guessing access tokens | S | 256-bit random tokens with prefix + checksum; SHA-256 hash at rest; constant-time compare; rate limit on auth failures | P2-05, P2-07 |
| T2 | Token from project A used on project B | E | Token bound to a single project audience; OAuth audience = per-slug resource URL (RFC 8707); tests | P2-12, P5-02 |
| T3 | Calling a tool or account not granted | E | Server built per request with allowed tools only; second check at execution; account intersection | P2-04, P2-12 |
| T4 | **NRQL / GraphQL injection** through tool arguments (e.g. entity name `x' OR …`, trailing backslash breaking out of a GraphQL string — seen in community servers, prior-art S1) | T/I | **GraphQL variables only** — NRQL and every value travel as typed variables (`$nrql: Nrql!`), never interpolated into documents; single escaping helper for NRQL string literals inside templates; typed validators for ids/guids/time ranges/enums; fuzz tests | P1-02, P1-04, P8-01 |
| T5 | Expensive or unbounded queries (cost, DoS of NR account limits) | D | Query limits: LIMIT injection or limit, max time window, event-type lists, byte caps; per-grant rate limits; concurrency cap | P1-04, P2-07 |
| T6 | **Prompt injection via telemetry** (logs telling the agent to run destructive actions or leak data) | T | Tool output wrapped in a delimited "untrusted telemetry data" envelope; read-only default; write tools opt-in + per-grant; documentation for users | P1-05, P7-09 |
| T7 | Stolen database or D1 export reveals NR keys | I | AES-256-GCM envelope encryption; AAD = credential id + key version (prevents ciphertext swapping); master key only in secret store/env; rotation command | P2-03 |
| T8 | Secrets leaking to logs, errors, audit or LLM output (incl. upstream error bodies echoed verbatim and queries printed to stdout — prior-art S7, S8) | I | Central redaction (NRAK/NRAA/NRAL/NRII/… keys, `rb_` tokens, Bearer/`Authorization`); upstream errors mapped to stable codes and truncated; logs only to stderr, structured; tests assert no secret patterns in logs | P1-01, P1-02, P2-08 |
| T9 | OAuth: open redirect / authorization-code interception | S/E | PKCE (S256) required; exact redirect URI match; CIMD document validation; issuer param (RFC 9207); state/CSRF checks | P5-03, P5-04 |
| T10 | OAuth: malicious DCR client floods or phishing consent | S/D | Registration rate limit; consent screen shows client name and redirect host; per-client approval remembered; admin can revoke clients | P5-03, P5-04 |
| T11 | SSRF through CIMD metadata fetch | I | Rely on provider's protections; block private, link-local and metadata IP ranges; size and time limits; HTTPS only | P5-03 |
| T12 | Token passthrough / confused deputy | E | Client tokens are **never** forwarded to NerdGraph; NR keys are server-side only; pass-through mode uses a dedicated header and never stores keys | P2-06 |
| T13 | Admin panel XSS / CSRF / clickjacking | T/E | SSR with auto-escaping; strict CSP (no inline scripts); CSRF tokens; `SameSite` cookies; `frame-ancestors 'none'` | P4-02, P4-07 |
| T14 | Admin account takeover | S | IdP login only (Google, GitHub, CF Access, OIDC); allowlists of emails/domains/orgs; owner bootstrap token is single-use and expires | P4-01, P4-02 |
| T15 | Revoked token still works due to caching | E | Cache TTL ≤ 60 s (configurable, 0 disables); documented; OAuth access tokens are short-lived | P2-06, P5-05 |
| T16 | Cross-tenant data mixing in cache | I | Cache key includes credential id + accounts + normalized NRQL; never shared across credentials | P7-02 |
| T17 | Repudiation of actions | R | Append-only audit log with user, grant, token/client, tool, redacted NRQL, result status | P2-08 |
| T18 | Malicious dependency or compromised Action | T | Lockfile, Renovate with review, actions pinned by SHA, least-privilege workflow permissions, npm provenance, signed Docker images, SBOM, OpenSSF Scorecard | P0-03, P0-04, P1-15, P2-11 |
| T19 | Timing / enumeration on slugs | I | Same 401 response for unknown slug and bad token | P2-06 |
| T20 | Abuse of a public instance's compute (cost on Workers Paid) | D | Auth required on all MCP routes; unauthenticated routes are static or cheap; rate limits | P2-07, P3-04 |
| T21 | **Cross-request credential bleed**: request A's NR key or grant visible to concurrent request B through module-level state (seen in a community server, prior-art S4; Workers isolates serve many requests) | I/E | No module-level mutable request state — credentials and grants travel only in the explicit per-request `ToolContext`; isolate caches keyed by credential id and holding no plaintext keys; two-tenant concurrency test | P1-01, P2-12 |
| T22 | **Raw GraphQL passthrough** bypasses every per-tool control and enables mutations (prior-art S2) | E | No raw NerdGraph tool by default; if ever offered: separate grant, parsed and query-only (reject `mutation`/`subscription`), account-scoped | P6-15 |
| T23 | **Secrets through the model**: tools that accept API keys as arguments put them in transcripts and let an injected model change credentials (prior-art S6) | I/T | Never accept secrets as tool arguments; credential management is admin-API/CLI only, never an MCP tool | P1-01, P2-09 |
| T25 | OAuth provider stores grant `userId` / metadata **unencrypted** in KV keys/metadata (only `props` are encrypted) | I | Opaque random user ids (never emails) as `userId`; never put secrets or PII in grant metadata | P5-01 |
| T26 | `embeddedChartUrl` / `staticChartUrl` create public, unauthenticated chart links to telemetry (merely *selecting* `staticChartUrl` generated a signed snapshot URL in P0-09) | I | Never select these fields by default; opt-in per project with a warning; never auto-share; test that default NRQL documents don't contain them | P1-03, P7-03, P7-04 |
| T24 | **DNS rebinding / cross-origin** calls to a local HTTP server (`relic-bridge serve` on localhost) | S/E | Validate `Host` and `Origin` (allowlist), bind `127.0.0.1` by default, auth even on localhost in serve mode | P2-06 |

## 5. Security requirements checklist (non-negotiable)

- [ ] All MCP and admin routes require authentication in remote modes; only `/health` and `/.well-known/*` are public.
- [ ] Read-only by default; any tool with side effects is `annotations.readOnlyHint=false` and disabled by default.
- [ ] No secret is ever written to logs, errors, audit, tool output or telemetry.
- [ ] Every value sent to NerdGraph travels as a **GraphQL variable**; values embedded in NRQL templates go through the `nrql` tag / `nrql.identifier()`.
- [ ] No module-level mutable state holds request credentials or grants.
- [ ] No MCP tool accepts a secret as an argument or manages credentials.
- [ ] Every new endpoint has authz tests, including negative cases.
- [ ] Docs explain the prompt-injection risk and the read-only default.

## 5a. Implementation status

| Threat | Control in code | Since |
|---|---|---|
| T8 | `redact` / `redactValue` (NR keys, `rb_` tokens, Bearer, `*_KEY=` assignments, secret-named fields); mandatory in `createLogger` and `toToolErrorResult`; `Secret` wrapper; unknown errors → `RB_INTERNAL` with no message leak | P1-01 |
| T21 | `ToolContext` per request, `buildMcpServer` per request; isolation test with two concurrent servers | P1-01 |
| T23 | `ToolRegistry.register` rejects secret-like input properties anywhere in the schema | P1-01 |
| T6 / P7-09 | `ToolRegistry` refuses `write` / `destructive` tools unless `allowNonRead`; MCP annotations derived from `kind` | P1-01 |
| T4 | `defineDocument`: static named documents, string literals rejected, so values can only be variables; `NerdGraphClient.query` takes only such documents | P1-02 |
| T5 | Per-credential semaphore (`LimiterPool`, default 5); response cap enforced while streaming, before `JSON.parse`; one budget unit per attempt, retries only within budget | P1-02 |
| T8 | NerdGraph errors mapped to `RB_*` codes; non-2xx bodies only classified (≤ 4 KiB read), never returned; GraphQL messages redacted and truncated (500 chars); tested with an upstream that echoes the key | P1-02 |
| T12 | The NR key is read only inside `NerdGraphClient` (`API-Key` header); documents can't override reserved headers (`API-Key`, `Authorization`, `Cookie`, …) | P1-02 |

## 6. Open questions

- Pass-through mode: should it be off by default on Workers? (Proposed: yes.)
- Should audit log store full NRQL (useful) or only hash + event types (more private)? (Proposed: configurable,
  default full NRQL with literal values masked.)
