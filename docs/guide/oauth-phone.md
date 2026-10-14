# Use relic-bridge from your phone and claude.ai

Goal: your **laptops and desktops** keep using device tokens (Claude Code, Cursor, VS Code), and your **phone** and
**claude.ai on the web** connect with OAuth. Both reach the same projects, each with its own revocable access.

> **Not yet verified with the real apps.** claude.ai and the Claude mobile apps have not been run against a
> relic-bridge server. The server side is tested with the official MCP client acting like them
> ([client compatibility](../reference/client-compatibility.md)); the Claude steps below come from Anthropic's
> documentation (read 2026-10-05) and are marked **unverified**. Walk the manual checklist in
> `docs/pending-decisions/phase-5.md` and tell us what differs.

## What you need

- A relic-bridge server on a **public https address**: [self-hosted](self-hosting.md) behind TLS or
  [on Cloudflare](cloudflare-deploy.md). claude.ai and the phone app connect from Anthropic's servers, not from your
  device, so `localhost`, a home LAN address or a VPN-only name never works.
- [Sign-in](identity-providers.md) set up (`RB_PUBLIC_URL` plus a provider) and you can sign in to `/admin`.
- A project with a **grant** for you (admin panel: Projects, then Grants; or **My access**). OAuth apps can only receive
  what one of *your* grants allows.
- A Claude plan that allows custom connectors. Anthropic: Pro and Max users add them themselves; on Team plans only
  owners, on Enterprise owners and roles with the right permission (**unverified**, may change).

## 1. Turn OAuth on

Set `RB_OAUTH=on` and restart (Node), or add it under Variables (Cloudflare) and redeploy. Check, from any machine:

```sh
curl -s https://bridge.example.com/.well-known/oauth-authorization-server
curl -si -X POST https://bridge.example.com/p/work/mcp | head -5     # 401 with WWW-Authenticate ... resource_metadata=
```

`RB_PUBLIC_URL` **must be the address you will type into Claude**, exactly (scheme and host). A `*.workers.dev` alias
that differs from it makes careful clients stop with a resource mismatch. Variables and defaults:
[OAuth guide](oauth.md#turn-it-on).

## 2. Add the connector in claude.ai (web)

Steps per Anthropic's [custom connector help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
(**unverified**; menu names change):

1. In claude.ai open **Customize**, then **Connectors**.
2. **+ Add**, then **Add custom connector**.
3. Name it (for example `relic work`) and paste the **project URL**: `https://bridge.example.com/p/work/mcp`
   (`{RB_PUBLIC_URL}/p/{slug}/mcp`). One connector per project.
4. Under authentication choose to sign in now. For the OAuth client keep Claude's published identity (the recommended
   option): relic-bridge recognises it through its metadata document. If Claude falls back to **Register
   automatically**, that is dynamic registration (`RB_OAUTH_DCR`, on by default). **Don't** choose your own client id
   and secret: none exists.
5. Add. Claude sends you to your server's page. Sign in if asked.
6. The **consent page** shows who is asking (`claude.ai`), where it sends you back, the project, and **your grants** on
   it. Pick the grant, optionally name the device (`Phone`, `claude.ai`), and optionally tick **Don't ask again for
   this app** (remembers the approval for 30 days, for this app, address and project only; offered because claude.ai
   is identified by its website). **Allow**.
7. Back in Claude the connector shows as connected. In a chat use the **+** button, then **Connectors**, and switch it
   on for that conversation (**unverified**).

Add the second project the same way with its own URL and, if you like, a different grant.

## 3. Use it from the Claude mobile app

Anthropic says connectors added in claude.ai are available in the Claude mobile apps (**unverified**; the help page has
no mobile-specific steps). So:

1. Add and approve the connector on the **web** first, as above (the consent page also fits a phone screen, but the
   web is easier).
2. Open the Claude app signed in to the same account, start a chat, open the tools/connectors menu and enable it.
3. If the app asks you to sign in again, it opens the same consent page in a browser view. Approve it.

If the phone does not show the connector or fails to authorize, note what happened and the audit log rows
(`oauth.consent.approve`, `oauth.token.refused`) and report it: this path is the one that was never run for real.

## 4. Your laptops

Keep using one **device token per machine** with Claude Code, Cursor and VS Code
([multi-device setup](multi-device.md), [client setup](clients.md)). Tokens suit clients that can send a header and
that you can configure once; OAuth suits apps where you can't. Claude Code can also use OAuth (`/mcp`, then sign in),
if you prefer no token files.

| Device | How it connects | Revoke by |
|---|---|---|
| MacBook, PC, Windows 365 desktop | device token per machine | Devices page, **Revoke…** |
| Phone, claude.ai web | OAuth, one approval per app and project | **My access** or the user's page, **Disconnect…** |

## Revoking (per device)

- **Lost phone, one app:** **My access** (`/admin/me`) lists **Apps connected with OAuth** with device name, project and
  grant. **Disconnect…** ends its access and refresh tokens at once and forgets "don't ask again". Admins can do it
  from a user's page.
- **Everything an app holds, for all users, or an app you don't trust:** owners use **OAuth apps**
  (`/admin/oauth-clients`), *Remove…*. Once your apps are listed there, switch **dynamic client registration** off.
- If an app was removed but had very many authorizations, the page says to remove it again: repeat until it reports
  done.
- **Revoke the grant** and every device or app approved with it stops.
- Already issued access tokens stop on the handling server immediately and on other Worker isolates within
  `RB_ACCESS_CACHE_TTL` (30 s); renewals are refused everywhere at once.

## Token lifetimes

- **Access token:** 1 hour (`RB_OAUTH_ACCESS_TTL`, 60 s to 24 h), never longer than its grant.
- **Refresh token:** rotates on every use. The approval as a whole ends after `RB_OAUTH_REFRESH_TTL` (30 days by
  default; renewing does not extend it) and you approve again.
- **Reuse window:** an app that renews twice at once with the same refresh token gets the same new tokens for
  `RB_OAUTH_REFRESH_REUSE_WINDOW` seconds (default 30; `0` = strict). Outside it, reuse is treated as theft and
  disconnects the app ([ADR-0013](../adr/0013-refresh-token-reuse-interval.md)).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Claude says it can't reach the server, or no sign-in page opens | The server is not publicly reachable over https (localhost, LAN, VPN, firewall that blocks Anthropic's addresses), or `RB_OAUTH` is off (`/.well-known/oauth-authorization-server` is a 404). |
| Sign-in or authorization fails right after you paste the URL: "resource mismatch" or similar | The URL typed differs from `RB_PUBLIC_URL` (a `workers.dev` alias, `http`, another hostname, a trailing path). Fix `RB_PUBLIC_URL`, or use the public URL in the connector, then **remove the connector and add it again** so Claude discovers the metadata afresh. |
| `403 forbidden_host` | The `Host` header is not in `RB_ALLOWED_HOSTS` (self-hosted), or the proxy rewrites it. |
| The consent page says you have no grant | You have no grant on that project: ask an admin for one ([access model](access-model.md)). The page offers Deny only. |
| Asked to approve again every few weeks | Normal: `RB_OAUTH_REFRESH_TTL` ended, or the grant expired. |
| Connector worked, then asks to sign in again / `invalid_grant` | The app was **disconnected**: you or an admin did it, its grant was revoked or expired, the user was disabled, or its **refresh token was reused** (audit `oauth.token.reuse`). Approve it again. If reuse keeps happening on its own, check for `oauth.token.replay` rows and keep the reuse window above 0. |
| Tools fail with `401` for one project only | The token is for another project (one connector per project) or the project was disabled. |
| Claude registers a new client every time | It fell back to dynamic registration (the metadata-document path was not used). Works, but fills the **OAuth apps** list and counts against `RB_OAUTH_DCR_LIMIT` (30 per hour). Make sure the server is on `https` and publicly reachable so Claude can use its metadata document; on Workers keep the `global_fetch_strictly_public` flag. |
| `/oauth/register` returns 404 | Dynamic registration is off (`RB_OAUTH_DCR=off` or the switch in **OAuth apps**). Fine if Claude uses its metadata document; turn it on temporarily if a client needs it. |
| `429` on `/oauth/*` | Per-address OAuth rate limit (60 per 5 minutes) or the registration cap; wait, and behind a proxy set `RB_TRUSTED_PROXY_HOPS`. |

How the pieces fit: [how OAuth works in relic-bridge](oauth-how-it-works.md).
