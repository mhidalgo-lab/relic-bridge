# 0012 — Client ID Metadata Documents resolved by relic-bridge, with a per-runtime SSRF guard

- Status: accepted (P5-03, 2026-10-05; supersedes the CIMD part of ADR-0009's spike outcome)
- Date: 2026-10-05

## Context
ADR-0009 enables CIMD through `@cloudflare/workers-oauth-provider`'s own support and, on Node, only "together with a
connect-time SSRF guard". Reading the 1.2.1 source (P5-03):

- The provider enables CIMD only when `Cloudflare.compatibilityFlags.global_fetch_strictly_public` is true. On Node
  that global would have to be faked, and the provider would then call the process-wide `fetch` — which has no guard
  and **follows redirects** (`redirect` is not set), so a public document URL could bounce the fetch to a private
  address.
- It caches validated documents in the Workers Cache API (absent on Node, per-colo on Workers) and holds redirect
  URIs to its own safety checks only (any https host).
- MCP 2026-07-28 makes CIMD the preferred registration method (claude.ai, Claude mobile and Claude Code use it when the
  AS metadata advertises `client_id_metadata_document_supported` with the `none` auth method), so it must work on both
  runtimes, not only Workers.

## Decision
- The provider's CIMD stays **off** (`clientIdMetadataDocumentEnabled: false`). relic-bridge resolves an https
  `client_id` itself before the provider sees the request (`/oauth/authorize`, `/oauth/token`, and again at consent
  approval), and stores the validated document as an ordinary provider client record (`oauth:client:<url>` in the
  storage `kv` table, ADR-0011) for its HTTP cache lifetime bounded to 5 min – 24 h. The provider then treats the
  client as a stored public client (exact redirect matching, PKCE, RFC 8252 loopback ports).
- The fetch goes through a **host-supplied fetcher** (`oauth.clientMetadataDocuments.fetch`); without one CIMD is off
  and URL client ids are refused. Each runtime provides its own guard:
  - **Node** (`apps/cli/src/cimd-fetch.ts`): `node:https` with a `lookup` that resolves every address and refuses the
    host unless all are public unicast; IP literals checked before connecting. The socket connects to the address that
    was checked, so DNS rebinding has no window. No redirects, fresh connection per fetch, bounded body and time. No new
    dependency (ADR-0009 named undici's `connect.lookup`; `node:https` gives the same connect-time hook).
  - **Workers** (`apps/worker/src/cimd-fetch.ts`): a Worker cannot resolve DNS, so the guard is the platform's egress
    (no route into private networks without a VPC/Tunnel binding), the `global_fetch_strictly_public` compatibility
    flag (requests to our own zone go through Cloudflare's front door instead of straight to the origin) and
    `redirect: 'manual'`, on top of the shared client-id checks. Off if the flag is missing at runtime. Whether the
    platform refuses a public hostname that resolves to a private address is not documented; to verify on a
    deployment (P5-06).
- Policy shared by both (`packages/http-app/src/oauth/clients.ts`): canonical https client id with a path, DNS name
  only (no IP literal or internal names), port 443, not the issuer; 5 s, 5 KiB, JSON media type, 200 only, no
  redirects; `client_id` string-equal to the URL; no secrets; public clients only; https redirect URIs only on the
  client id's own host (others are dropped), loopback http allowed.

## Consequences
- One CIMD implementation and one cache (strongly consistent storage) on Node and Workers; the OAuth integration suite
  covers it on memory, SQLite and D1 with a mocked fetcher.
- The `global_fetch_strictly_public` flag applies to every outbound fetch of the Worker (NerdGraph and sign-in
  providers are public, so nothing changes for them).
- Redirect URIs on another host than the document's are not usable: a client whose callback lives on a different host
  than its metadata document can't use CIMD with relic-bridge (DCR still works). Owner decision logged.
- A provider upgrade that changes how it reads `client:` records for URL client ids must be re-checked (the suite
  fails if the cached record is not honoured).
