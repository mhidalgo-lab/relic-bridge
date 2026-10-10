# Client compatibility

Which MCP clients can connect to relic-bridge with OAuth (`RB_OAUTH=on`), and how sure we are. Written in P5-06 on
2026-10-05 against relic-bridge at the P5-05 branch, MCP spec 2026-07-28 and MCP TypeScript SDK client 2.2.0.

**No real client account was used.** claude.ai, Claude mobile, Claude Desktop, Cursor, VS Code, ChatGPT and MCP
Inspector were not run against a relic-bridge server. What is verified is the server's behaviour towards the **official
SDK client acting like each client family**, using what the vendors document about how those clients register,
redirect and refresh. Every cell says which kind of evidence it rests on:

| Mark | Meaning |
|---|---|
| **T** | Verified by an automated conformance test (SDK client shaped like that client, `pnpm test`, the Worker on `pnpm test:workers`). Says nothing about the real app's own quirks. |
| **D** | Documented by the vendor (source below), not exercised. |
| **?** | Unknown: no documentation found or the documentation is silent. |
| **M** | Needs the owner's manual check (steps in `docs/pending-decisions/phase-5.md`, "P5-06 manual verification checklist"). |

## Clients

| Client | How it identifies itself | Redirect URI | Evidence |
|---|---|---|---|
| **claude.ai (web)** | CIMD `https://claude.ai/oauth/mcp-oauth-client-metadata` when the server advertises `client_id_metadata_document_supported` and `none`; else DCR | `https://claude.ai/api/mcp/auth_callback` | D (Claude connector docs); shape tested (T) |
| **Claude mobile (iOS, Android)** | Same hosted client as claude.ai: the vendor says web, Desktop, mobile and Cowork share one OAuth client and callback | same | D; **M** (never run) |
| **Claude Desktop** (remote connectors) | same hosted client | same | D; **M** |
| **Claude Code** | Its own CIMD `https://claude.ai/oauth/claude-code-client-metadata`; else DCR; optional `--client-id` | loopback `http://localhost:<port>/callback` (127.0.0.1 in v2.1.229) | D; shape tested (T) |
| **Cursor** | DCR, or static client in `mcp.json` | desktop `http://localhost:8787/callback`; web/cloud agents `https://www.cursor.com/agents/mcp/oauth/callback` | D (partial); DCR with loopback and custom-scheme redirects tested (T) |
| **VS Code** (GitHub Copilot) | VS Code docs say nothing about OAuth registration | ? | ? |
| **MCP Inspector** | Official SDK client (DCR, loopback callback) | loopback | the SDK client is what the suite drives (T); the Inspector UI itself not run |
| **ChatGPT** (apps / connectors) | CIMD preferred, DCR, or predefined | `https://chatgpt.com/connector_platform_oauth_redirect` | D; not tested |

A relic-bridge CIMD client may only send codes to `https` redirect URIs on **its own client id host** (P5-03). That
fits Claude Code and the hosted Claude apps (the document is on `claude.ai`, the callback on `claude.ai`) but **not**
ChatGPT (callback on `chatgpt.com`; where its document lives is not documented), nor a `claude.com` callback if Claude
ever uses one. Such clients fall back to DCR (any https host by default), which works.

## Behaviours

Columns: **hosted Claude** = claude.ai / mobile / Desktop (CIMD, https callback; same hosted client per vendor),
**Claude Code** (CIMD, loopback), **DCR clients** = Cursor, VS Code, Inspector and anything else registering with
`/oauth/register`. "T" means the SDK-client conformance test for that shape passes; the real client is still M or ?.

| Behaviour | Hosted Claude | Claude Code | DCR clients | Notes |
|---|---|---|---|---|
| Unauthenticated MCP call gets `401` with `WWW-Authenticate: Bearer resource_metadata=…, scope="mcp:read"` | T, D (a `401` is required: Claude ignores the header on a `200`) | T, D | T | Same bytes for every denial (T19). |
| Discovery: PRM (path insertion) then RFC 8414 AS metadata | T, D | T, D | T | No OIDC document, no root PRM. Claude uses the first `authorization_servers` entry (one here). |
| `resource` in PRM equals the URL the user typed | D, **M** | D | ? | Use the public URL (`RB_PUBLIC_URL`); a `*.workers.dev` alias breaks it. |
| CIMD chosen only with `client_id_metadata_document_supported` **and** `none` in `token_endpoint_auth_methods_supported` | T (both advertised), D | T, D | n/a | |
| CIMD document fetched and validated; redirect URI matched | T (documents shaped like both Claude clients) | T (loopback, any port) | n/a | Real documents were not fetched (no network in tests); **M**. |
| DCR (`/oauth/register`): loopback, https and private-use (`cursor://`) redirects | T | n/a | T | claude.ai falls back to DCR without CIMD and then registers a new client for every fresh connection (D); the 30/hour cap applies. |
| PKCE `S256` on the authorization request | T, D (Claude always sends S256) | T | T | |
| `resource` on authorization **and** token requests, including refresh | T, D (ChatGPT also documented) | T | T | Strict on refresh (P5-02). No client found that omits it on refresh. |
| `iss` on the redirect (RFC 9207) accepted by the client | T (SDK) | T | T | |
| Scopes: `mcp:read offline_access`, `mcp:read`, none, and a bare `mcp offline_access` all authorize | T | T | T | Claude takes the challenge's `scope`, appends `offline_access` when AS metadata lists it (D); reported client sending bare `mcp`: accepted here. |
| Streamable HTTP: `initialize` (or `server/discover`), `tools/list`, `tools/call` with the bearer token | T | T | T | Real Claude Code speaks 2026-07-28 (P0-07); the SDK client used here negotiates the same transport. |
| Token endpoint accepts `application/x-www-form-urlencoded` | T, D | T | T | JSON bodies are refused (as the provider). |
| Refresh after the access token expires, with `resource` and the one-time rotated refresh token | T | T | T | Reactive on `401` (all); Claude also refreshes **proactively up to 5 minutes before expiry** (D). |
| Refresh response must carry a **new** refresh token | T | T | T | Both Claude docs and OAuth 2.1 expect rotation for public clients (D). |
| Old refresh token refused after rotation (`invalid_grant`) and its reuse revokes the device | T | T | T | RFC 9700 §4.14.2; P5-05. Inside the reuse interval (default 30 s, P5-09) the same client gets the same pair again; after it, reuse revokes. |
| Several requests over an expired token at once | **finding, see below** | T (SDK: device kept by the reuse interval; revoked in strict mode) | T (same) | Real client behaviour: ? / **M**. |
| RFC 7009 revocation at `revocation_endpoint` (`/oauth/token`) | T | T | T | Whether the real apps call it on disconnect: ?. |
| After the device is revoked, the client gets a clean `invalid_grant` and goes back to sign-in, no refresh loop | T (SDK: drops tokens, asks for authorization, at most 2 refresh attempts) | T | T | Claude docs ask for `invalid_grant` and a "clean reconnect" (D). |
| A token for one project is refused on another, with that project's own challenge | T | T | T | RFC 8707 audience binding. |
| Latency: discovery, registration and token endpoints within 10 s, refresh within 30 s | D, **M** | ? | ? | Not measured against Workers cold starts with real network. CIMD fetch itself is capped at 5 s. |
| Reachability: Claude calls from `160.79.104.0/21`, not from your machine | D, **M** | n/a (local) | n/a | Phone and web connect from Anthropic's servers: `localhost` and private hosts never work. |
| Consent screen usable on a phone browser | (P5-04 browser test, 320 px) | n/a | n/a | The real app's in-app browser: **M**. |

### Finding: parallel refresh and strict rotation

The SDK client (2.2.0) does **not** coalesce refreshes. Three tool calls started over an expired access token produced
six refresh requests (each failed request refreshes, and a failed refresh is retried once). With P5-05's strict single
use, the first wins and the rest are reuse: **the device is revoked** and the person must approve the app again. A
sequential session (any number of refreshes, one at a time) is fine on every shape. The standalone GET stream the SDK
opens after `initialized` is a second source of concurrent 401s.

Whether claude.ai, Claude mobile, Claude Code, Cursor or VS Code refresh concurrently is unknown; Claude refreshes both
proactively and on `401` (D), which makes an overlap possible.

**Resolution (P5-09, ADR-0013):** a refresh token **reuse interval**, default 30 s (`RB_OAUTH_REFRESH_REUSE_WINDOW`,
0-120, `0` = strict). One request rotates the token; the others (waiting for it if it is still running) get the same
new pair, sealed in storage for the window only. With it the SDK's parallel refreshes all succeed and the device stays
(tested on every client shape and storage); with `0` the device is revoked as before. Reuse after the window, of an
older generation or by another client still revokes. The default is the owner's to confirm (pending decision
"P5-09 — refresh reuse interval"). When running the manual checklist, an `oauth.token.replay` row in the audit log means
the client did refresh concurrently.

## Not covered (and why)

- **MCP Inspector CLI / `mcp-remote`**: both need an interactive browser sign-in and consent; they cannot run without
  a person and a configured identity provider. They use the same SDK client the suite drives.
- **Real client apps**: need real accounts (claude.ai, mobile, Desktop, Cursor, VS Code, ChatGPT) and a deployed server
  reachable from the internet. See the manual checklist.
- **Real CIMD document fetches** (`claude.ai/oauth/...`): tests use stand-in documents shaped like the documented ones.

## Re-run procedure (each minor release)

1. `pnpm test && pnpm test:workers` (the suite is `packages/http-app/test/authz/client-conformance-suite.ts`, run on
   memory, SQLite and the Worker). Bump `@modelcontextprotocol/client` first when a new SDK is out and re-read the
   findings above.
2. Re-read the vendor pages below and update any "D" that changed.
3. Walk the manual checklist with a real phone and claude.ai; change **M** to a dated result.

## Protocol behaviours clients can rely on (P5-12)

- `prompt=none`: answered without a page (`login_required`, `consent_required`, or a code for a remembered approval).
- `redirect_uri` on the token request: optional, checked when sent. Clients that send it (RFC 6749 §4.1.3) are fine.
- Redirect `http://[::1]:port/…` works, but the browser lands on a short "Return to the app" page first (it navigates by
  `Refresh` and a link); prefer `http://127.0.0.1:port/…` or `localhost`.

## Sources (read 2026-10-05)

- Claude connectors authentication: <https://claude.com/docs/connectors/building/authentication> (callback URL, CIMD
  and DCR selection, `401` requirement, refresh, latency, shared hosted client).
- Claude custom connectors help: <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
  (plans; web, Desktop, mobile).
- Claude Code MCP: <https://code.claude.com/docs/en/mcp> (DCR, CIMD, `--callback-port`, `localhost` callback, refresh and
  one retry on `401`).
- Cursor MCP: <https://cursor.com/docs/context/mcp> (static OAuth, redirect URLs).
- VS Code MCP servers: <https://code.visualstudio.com/docs/copilot/customization/mcp-servers> (no OAuth details).
- ChatGPT apps authentication: <https://developers.openai.com/apps-sdk/build/auth> (CIMD, DCR, `resource`, redirect).
- claude.ai scope report: <https://github.com/anthropics/claude-ai-mcp/issues/1092> (`mcp offline_access`, `prompt=consent`).
- MCP authorization (2026-07-28): see `docs/RESEARCH.md`.
