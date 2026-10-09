# The admin panel

The admin panel at `<RB_PUBLIC_URL>/admin` manages everything the [admin API](../reference/admin-api.md) does, from
a browser or a phone: New Relic keys, projects, grants, device tokens and users. It needs sign-in
([identity providers](identity-providers.md)); sessions, roles and CSRF rules are in [admin access](admin-access.md).

Who sees what:

| Role | Panel |
|---|---|
| owner | everything, including adding or changing owners |
| admin | keys, projects, grants, devices and users (not owners) |
| member | the overview only (self-service is planned, P4-10) |

The screens work without JavaScript. The only script adds copy buttons.

## A personal setup in five steps

The common case: you, two New Relic accounts (one in the US data center, one in the EU), a laptop and a phone.

1. **Keys** → *Add a key*. Name it (`Work US`), pick the region, paste your New Relic **User** key (`NRAK-…`) and
   choose *Check and add*. The key is checked with New Relic before it is saved. The key page then shows the New
   Relic user it belongs to and the accounts it can reach. Repeat for the EU key.
2. **Projects** → *New project*. First choose the default key; its region is the project's region. Then name the
   endpoint (the slug: `work-us` gives `/p/work-us/mcp`), tick the accounts it may use (offered from the key's
   reachable accounts), pick the default account, and choose the tools: *All tools, including later ones*, or a
   list. Tools are grouped by category, each with a `read` or `write` badge. Leave the query limits blank for the
   defaults, or tighten them. Repeat for the EU project.
3. **Grants** → *New grant*. Choose the project, then who it is for (you, another user, or a service such as a CI
   job with a label). Keep *Project default* as the key, or pick a shared key or that person's own key (bring your
   own key). Optionally narrow the tools and accounts, add a rate limit and an expiry.
4. **Devices** → *New device token*. Choose the grant, name the device (`laptop`, `phone`) and a lifetime (90 days by
   default). The next page shows the token **once**: copy it into the device's MCP client right away. It is not
   stored and cannot be shown again. Do not reload that page: that would create another token.
5. Connect the client: the same page lists copy-paste snippets for Claude Code, Cursor, VS Code and Claude Desktop with
   the endpoint and the token filled in where it must be (see **Connect** below, and [clients](clients.md)). One token
   per device lets you revoke a lost phone alone.

## Screens

**Keys** (`/admin/credentials`). The list shows the name, region, `•••• last4` of the key, owner (shared or a
person), status (`valid`, `refused`, `not checked`), New Relic user and number of reachable accounts. A key page also
lists what uses it. From there:
- *Check again with New Relic* refreshes the reachable accounts. If New Relic refuses the key, it is marked refused
  and everything using it stops until you replace it. If New Relic cannot be reached, nothing changes.
- *Replace the key* takes a new key and a confirmation box. The new key is checked first. You are warned when it
  belongs to a different New Relic user than the old one. Revoke the old key in New Relic afterwards.
- *Delete* is refused while a project or grant still uses the key.

A key is never shown again after you paste it: not on its page, not in a form shown again after an error, not in a
URL or a log. Keys that come from the environment or a config file are listed but can't be replaced here.

**Projects** (`/admin/projects`). Each project is one MCP endpoint. Its page shows the full endpoint URL, its grants
(with *New grant*), and the edit form. Narrowing a project (fewer accounts or tools, tighter limits) narrows every
grant on it at once. If you remove the default key, the page lists the grants that relied on it (they stop). *Disable*
refuses every request until you enable it again. *Delete* removes the project with its grants and tokens.

**Grants** (`/admin/grants`). Filter by project or person. A grant page shows its key, tools, accounts, rate limit,
expiry and device tokens. Parts that its project does not allow are listed under *Parts with no effect*: access is
always the intersection of the grant and the project. A grant can't be edited: create a new one and revoke the old one.
*Revoke* stops all its tokens at once and keeps it listed. *Delete* removes it with its tokens.

**Devices** (`/admin/tokens`). Every token with its device name, prefix (`rb_live_Ab3d…`), grant, status, last use
(updated at most every 5 minutes) and expiry. *Revoke…* asks for confirmation, then the device loses access at once.
Connected OAuth clients (claude.ai, mobile) will be listed here with Phase 5.

**Connect** (`/admin/connect`, admins and owners). Choose a project to get snippets for Claude Code (a command and
`.mcp.json`), Cursor, VS Code, Claude Desktop and other clients. The address is built from the configured public URL
(`RB_PUBLIC_URL`), not from the request. The snippets never contain a token, because tokens are stored as hashes and
can't be shown again: the shell command reads it from `RELIC_BRIDGE_TOKEN` (`read -rs`, so it stays out of your shell
history) and the JSON files use the client's `${VAR}` expansion. The form *Create a token for this device* issues a token
through the same flow as **Devices**; its one-time page repeats the snippets with the real token filled into the one
that needs it (Claude Desktop's `mcp-remote` bridge). Copy buttons appear when your browser allows them; without
JavaScript, select the text. claude.ai on the web and the Claude mobile apps need OAuth (Phase 5).

**Users** (`/admin/users`). *Add a user* is the invitation: that person can then sign in with any configured provider
that confirms the email address (no email is sent, so tell them the panel's address). A user page shows their role,
sign-in provider, personal keys and grants. From there:
- Change the name or role (a role change signs them out everywhere). Only owners can make or change owners. Nobody
  can change their own role or disable themselves.
- *Sign out everywhere* ends all their panel sessions. Their device tokens keep working.
- *Disable* signs them out and stops their grants and personal keys until you enable them again.

**Audit** (`/admin/audit`). Everything the server recorded, newest first: tool calls, refused requests and
administrative changes. Filter by time (last hour up to 90 days, or everything kept), kind, status, tool or action
name, project, user and device; ids are shown with their names (a deleted project or user shows its id). Each row has
the result (error code, time, events inspected, accounts) and the query as stored (literal values are masked unless
the server is set otherwise). Pages hold 50 rows; *Next page* keeps your filter. *Download CSV* exports the same
filter, up to 5,000 rows (the newest; the download says nothing if it is cut off, so narrow the time range for
more), with ids rather than names. Cells that a spreadsheet could take for a formula start with an apostrophe. Members
can open this page too, but see only their own entries (their tool calls and the changes they made).

**Usage** (`/admin/usage`, admins and owners). Tool calls over the last 24 hours, 7, 30 or 90 days, grouped by tool,
project, grant, device or day: calls (with a bar), errors and denied calls with their share, mean and slowest time,
and events New Relic inspected. Below, the ten slowest calls of the window. Only tool calls are counted. On a
Cloudflare Worker with a very busy audit log, a 90-day view reads every row of the window; prefer shorter windows
there (see [Cloudflare limits](cloudflare-limits.md)).

## Confirmations and errors

Every destructive action asks first: revoking a token or grant, deleting a key, project or grant, disabling a project
or user, signing someone out everywhere, and replacing a key. Buttons in lists open a confirmation page; detail pages
show the explanation and the real button inline.

Errors from the admin API show up where they belong: a field message next to the field, a note above the form, or a
banner on the next page. *New Relic could not be reached* means nothing was changed and you can retry. Lists show 50
rows per page with *Next page*.

Screenshots of these screens are planned (P4-11).
