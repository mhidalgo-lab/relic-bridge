# OAuth: connect claude.ai, your phone and other apps

MCP clients that can't send a fixed header — claude.ai custom connectors (web and the Claude mobile app), Claude
Desktop connectors, Claude Code's `/mcp` login, MCP inspectors — connect with OAuth instead of a device token. The app
opens a page on your relic-bridge server, you sign in, choose which of your accesses the app gets, and approve. The app
then holds a token for that one project only.

Status: sign-in and consent (P5-04). Token lifetimes per plan, a list of connected devices and revoking one of them come
with P5-05; until then revoke the grant (admin panel → Grants) to cut an app off.

## Turn it on

OAuth needs [sign-in](identity-providers.md) (`RB_PUBLIC_URL` and at least one provider): people approve apps as
themselves.

| Variable | Default | Meaning |
|---|---|---|
| `RB_OAUTH` | `off` | `on` serves `/oauth/*`, the consent page and OAuth tokens on `/p/<project>/mcp`. |
| `RB_OAUTH_DCR` | `on` | Dynamic client registration (`/oauth/register`). Clients with a metadata document (claude.ai, Claude Code) don't need it. |
| `RB_OAUTH_DCR_LIMIT` | `30` | Dynamic registrations per hour for the whole server, or `off`. |
| `RB_OAUTH_DCR_REDIRECT_HOSTS` | any | Comma-separated https hosts dynamically registered clients may send codes to (for example `claude.ai`). Loopback addresses are always allowed. |

- **Node** (`relic-bridge serve`): set the variables and restart. Metadata documents (claude.ai's way of identifying
  itself) are fetched through a guard that refuses private and loopback addresses.
- **Cloudflare Workers**: add the variables in the dashboard (Settings → Variables) or `wrangler.jsonc`. Metadata
  documents need the `global_fetch_strictly_public` compatibility flag (on in the shipped `wrangler.jsonc`); without it
  the Worker logs a warning and claude.ai falls back to dynamic registration.

Use the public URL (`RB_PUBLIC_URL`) in the app, e.g. `https://bridge.example.com/p/work/mcp`. A `*.workers.dev`
address that differs from `RB_PUBLIC_URL` is refused by careful clients.

## What you see

1. The app sends you to `/oauth/authorize`. Not signed in? You go through sign-in first and come back.
2. The consent page:

   ![The consent page: who is asking, where it sends you, which access](images/oauth-consent-light.png)

   - **Who is asking.** An app identified by a metadata document shows the website that vouches for it (for claude.ai
     and Claude Code: `claude.ai`). A dynamically registered app is marked **not verified**: anyone can register any
     name, so continue only if you started connecting it yourself, just now.
   - **Sends you back to.** Where the approval goes. For claude.ai it is `claude.ai`. A red note warns when it is a
     program on your own computer (`localhost`, `127.0.0.1`), as for Claude Code: allow only if you just started it.
   - **Project** comes from the address the app was given; **access to give** lists your own grants on that project,
     with their tools and New Relic accounts. You can't give an app more than your grant allows, nor someone else's
     grant. No grant? The page says so and offers Deny only.
   - **Device name** (optional) labels this connection in your device list.
   - **Don't ask again for this app** (off by default) remembers the approval for 30 days, for this app, this
     address and this project only.
3. **Allow** sends the app back with a one-time code; **Deny** sends it back with `access_denied`.

On a phone the same page fits the screen (no zooming).

## Remembered apps

`/oauth/approvals` lists the apps you told not to ask again, with **Forget**. Forgetting makes the app ask next time;
tokens it already has keep working until they expire or the grant is revoked. A remembered approval also ends by
itself when its grant stops working (revoked, expired, key removed): you are asked again.

![Remembered apps](images/oauth-approvals-light.png)

## Security notes

- The consent page can't be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) and its form needs your
  session's CSRF token from this site. Each step checks the whole request again: the app, its registered redirect
  address, PKCE and the project.
- Codes go only to the redirect address the app registered (or listed in its metadata document), with `state` and the
  issuer (`iss`). Codes are single use.
- Approvals and denials are in the audit log (`oauth.consent.approve`, `oauth.consent.deny`, `oauth.consent.forget`).
- Developers: [docs/dev/oauth.md](../dev/oauth.md).
