# P0-08: deploy and test with real Claude clients

These steps are run by the maintainer. Nothing here has been deployed by the spike. The test Worker has fake
consent: **anyone who knows the URL can get a token**. That's acceptable only because the only tool is `echo`. Delete the
Worker as soon as the test is done (THREAT_MODEL T20).

## 1. Deploy (≈5 min)

```sh
cd spikes/oauth
pnpm install
pnpm exec wrangler kv namespace create OAUTH_KV
# copy the printed id into wrangler.jsonc → kv_namespaces[0].id (don't commit it)
pnpm exec wrangler deploy
# → https://relic-bridge-spike-oauth.<your-subdomain>.workers.dev
```

Smoke test from your machine:

```sh
node scripts/e2e.ts  https://relic-bridge-spike-oauth.<sub>.workers.dev   # DCR flow, cross-slug negative
node scripts/cimd.ts https://relic-bridge-spike-oauth.<sub>.workers.dev   # CIMD with Claude Code's real document
```

Both must print `ALL CHECKS PASSED`. On a deployed Worker, the CIMD check also proves `global_fetch_strictly_public`
works in production.

## 2. What each client should do

From the Claude connector docs (<https://claude.com/docs/connectors/building/authentication>):

| Client | Registration | Redirect URI | Notes |
|---|---|---|---|
| claude.ai web, Claude Desktop connectors, **Claude mobile** | **CIMD** (Anthropic-hosted document) when AS metadata has `client_id_metadata_document_supported: true` **and** `none` in `token_endpoint_auth_methods_supported`; otherwise **DCR** | `https://claude.ai/api/mcp/auth_callback` | Same client for all hosted apps. Uses only the first `authorization_servers` entry. 10 s limit on discovery/registration/token endpoints, 30 s on refresh. |
| Claude Code (CLI) | **CIMD** `https://claude.ai/oauth/claude-code-client-metadata` | `http://localhost:<any>/callback` or `http://127.0.0.1:<any>/callback` | Port changes each session. The provider's RFC 8252 loopback matching accepts both hosts (verified locally by `scripts/cimd.ts`). |

The spike's AS metadata advertises both CIMD values, so **every Claude surface should pick CIMD**. Record what you see
in the Worker logs (`pnpm exec wrangler tail`): a `POST /oauth/register` means the client fell back to DCR.

## 3. Connect

Use project `a`: `https://relic-bridge-spike-oauth.<sub>.workers.dev/p/a/mcp`.

**Claude Code**
```sh
claude mcp add --transport http spike-a https://relic-bridge-spike-oauth.<sub>.workers.dev/p/a/mcp
# then in Claude Code: /mcp → spike-a → Authenticate (opens browser; auto-approves)
```
Ask: *"call the echo tool from spike-a with message hello"*. The answer must contain `"project":"a"`.

**claude.ai web**: Settings → Connectors → Add custom connector → URL above → Connect. The browser bounces through
`/authorize` and back. Then in a chat, enable the connector and ask for echo.

**Claude mobile**: once the connector is added on claude.ai it's available on mobile (same account). Open a chat,
enable the connector, ask for echo. To test the mobile *connect* flow itself, remove the connector and add it again from
the mobile app if the app offers that.

**Cross-slug check (manual)**: add `/p/b/mcp` as a second connector. Both must work independently, and revoking one
(Settings → Connectors → Disconnect) must not affect the other.

## 4. Record results

For each client, fill in this table in `spikes/oauth/RESULTS.md` (§ Real-client results):

| Client + version | Registration used (CIMD/DCR) | Connected? | echo OK? | Refresh seen after 1 h? | Notes |
|---|---|---|---|---|---|

## 5. Teardown (required)

```sh
pnpm exec wrangler delete relic-bridge-spike-oauth
pnpm exec wrangler kv namespace delete --namespace-id <id>
```

Remove the connectors from claude.ai and `claude mcp remove spike-a`.
