# Admin access: sessions, roles and CSRF

The admin API (`/api/admin/v1`) accepts two kinds of callers:

| Caller | How | Role |
|---|---|---|
| Automation, the CLI (`--remote`), scripts | `Authorization: Bearer <RB_ADMIN_TOKEN>` | `owner` (break-glass) |
| A signed-in browser | the admin session cookie, plus a CSRF token on changes | the user's role |

Sign-in itself (Google, GitHub, Cloudflare Access, OIDC, the first-owner setup link) is described in
[identity providers](identity-providers.md). This page covers what happens after it.

## Sessions

- Signing in ends with a redirect (`303`) to the page you came from, carrying the cookie `__Host-rb_session` (on
  `http://localhost` the cookie is called `rb_session`, because browsers accept `__Host-` only over https). It is
  `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, with no `Domain`, so scripts and sibling subdomains can't read or
  set it.
- The session lives in the database (D1 on the Worker, SQLite on `serve`). The cookie holds a 256-bit random secret;
  the database keeps only its SHA-256 hash. Every request looks the session up, so a sign-out on one device or
  server instance takes effect everywhere at once.
- **Timeouts**: a session ends after `RB_SESSION_IDLE_MINUTES` (default 30) without a request, and
  `RB_SESSION_MAX_HOURS` (default 12) after sign-in, whatever the activity.
- **Session cap**: a user keeps at most 20 live sessions. Signing in a 21st time ends the oldest one (that browser is
  signed out; the `session.create` audit row shows `evicted`). Signing out everywhere takes a fixed, small number of
  database calls however many sessions exist.
- **Rotation**: each sign-in creates a new session and ends the one the browser had, so a cookie planted before
  sign-in never becomes a signed-in session.
- **Sign out**: `POST /auth/logout` with the CSRF token (form field `_csrf` or header `X-CSRF-Token`). Add
  `everywhere=1` to end every session of your user (all devices). An admin can do the same for a user with
  `POST /api/admin/v1/users/{id}/sessions/revoke`.
- **Privilege changes end sessions**: changing a user's role or disabling them ends all their sessions at once. A
  disabled user's session is also refused on every request (the user record is re-read at most every 5 seconds per
  server instance).

## Roles

| Role | Can |
|---|---|
| `owner` | Everything, including master-key rotation (`POST /keys/rotate`), owner setup links (`POST /setup-links`) and managing other owners and administrators. |
| `admin` | Manage users, credentials, projects, grants, tokens; read the audit log. Cannot create an owner, promote anyone to owner, or change or sign out an owner. Administrators are not peers either (P4-21): an admin session gets `403` (`detail: owner`) for creating a user as `admin`, promoting anyone to `admin`, and for editing, demoting, disabling, enabling, unbinding or signing out another admin; only an owner or the admin token does. An admin still manages members and can edit their own name or sign themselves out. Cannot act on an owner's keys, grants or tokens either: a credential owned by an owner, a grant of an owner or on an owner's key, and its tokens answer `403` (`detail: owner`) to change, rotate, delete, revoke and token issue; so do `ownerUserId` = an owner and a project `defaultCredentialId` that is an owner's key. |
| `member` | `GET /session`, signing out their own sessions, and `GET /audit` limited to their own entries (the `userId` filter is forced; usage statistics are admin-only). The self-service namespace `/api/admin/v1/me/*` (below): their own keys, their grants and device tokens. |

### Member self-service (`/api/admin/v1/me/*`)

Any signed-in user (member, admin or owner) can manage what is theirs; the bootstrap admin token cannot (`403`,
`detail: no_user`). The user always comes from the session: routes take no user id, and a body or query naming
`ownerUserId` or `userId` is refused (`400`).

| Route | What it does |
|---|---|
| `GET /me/credentials`, `POST /me/credentials` | List your New Relic keys (masked); add one (validated first, stored encrypted, always owned by you, at most 10). |
| `PATCH /me/credentials/{id}`, `DELETE ...`, `POST .../rotate`, `POST .../revalidate` | Rename, delete (`409` while a grant uses it), replace or re-check your key. |
| `GET /me/grants` | The grants an administrator assigned to you, with the project to connect to (`/p/{slug}/mcp`). |
| `PATCH /me/grants/{id}` `{"credentialId": "cred_..."}` | Use one of your keys for your grant, or `null` for the project default (only while the grant uses a key you own or the project default: when an administrator pinned another key, `422 not_permitted`, so a member cannot widen a narrowed grant). Tools, accounts and limits stay as the administrator set them. |
| `GET /me/tokens`, `POST /me/tokens`, `POST /me/tokens/{id}/revoke` | List, issue (shown once, at most 20 live per grant) and revoke device tokens on your grants. |

BYO-key flow: ask an administrator for a grant on the project, `POST /me/credentials`, `PATCH /me/grants/{id}`, then
`POST /me/tokens` for each device. A row that belongs to someone else answers `404 not_found`, exactly like a missing
one. Changes are audited as the usual actions (`credential.create`, `token.create`, ...) with `details.self: true`.
Members cannot create grants or change a grant's scope; that stays with administrators. The panel has screens for all of this: "My access" (below).

Nobody can change their own role or disable themselves through a session (ask another owner, or use the admin
token). Refusals are `403` with `"code": "forbidden"` and a `detail` (`role`, `owner`, `self`, `no_user`), and are written to the
audit log (`admin.forbidden`, or the refused change as `denied`).

**There is always an owner.** Demoting or disabling the last enabled owner is refused with `409`, `"code": "conflict"`,
`"detail": "last_owner"` (the admin panel says "This is the last enabled owner"), even with the admin token. Make
another user owner first. The check and the change are one storage write, so two owners demoting each other at the
same moment leave one of them an owner. A disabled owner does not count.

## CSRF and cross-origin rules (for API clients that use the cookie)

The session cookie is for the admin pages served by this instance. A request that carries it is accepted only when:

1. it has **no** `Authorization` header (a request with one is judged by the bearer token alone; its cookies are
   ignored);
2. `Sec-Fetch-Site` is absent, `same-origin`, or `none` (a typed URL) for reads;
3. for `POST`, `PATCH`, `PUT` and `DELETE`: `Origin` equals `RB_PUBLIC_URL`'s origin exactly (scheme, host and port),
   or, when a browser sends no `Origin`, `Sec-Fetch-Site: same-origin`; **and** `X-CSRF-Token` equals the session's
   token.

Get the token from `GET /api/admin/v1/session`:

```js
const me = await (await fetch('/api/admin/v1/session')).json();
await fetch('/api/admin/v1/projects', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.data.csrfToken },
  body: JSON.stringify({ slug: 'prod', defaultAccountId: 1, allowedAccountIds: [1] }),
});
```

`GET /session` also returns the role, the user and both expiry times (`expiresAt`, `idleExpiresAt`). A failed CSRF or
origin check is `403 forbidden` with `detail` `csrf`, `cross_site`, `origin_mismatch` or `origin_missing`.

## The admin panel (`/admin`)

Signing in lands on `/admin`, the admin panel. It is served by the same process as the API (`serve` or the Worker)
whenever sign-in is configured, and uses the same session:

- Without a session, any `/admin` address redirects to `/auth/login` and comes back to the same page after sign-in.
  Bearer tokens, including the admin token, never open a page.
- Every page carries a strict Content Security Policy (no inline script or style, nothing from other origins, no
  framing). Pages work without JavaScript; the one small script only adds copy buttons.
- Links into the panel from mail or chat work (a top-level navigation). Other cross-site requests (images, scripts,
  frames, `fetch`) are refused before the session is read.
- Each form carries the session's CSRF token and is accepted only from the panel's own origin. Changes go through
  the admin API as you, so the same role rules and audit rows apply.
- Sign out (this browser) and sign out everywhere are at the bottom of every page.

Admins and owners manage New Relic keys, projects, grants, device tokens and users there: see the
[admin panel guide](admin-panel.md). Moving a user to another sign-in provider (clearing the binding) is an owner-only
button on the user page, with a confirmation that states the takeover risk. Conventions for
contributors: [`docs/dev/admin-ui.md`](../dev/admin-ui.md).

### My access (`/admin/me`, every role)

Every signed-in person has a "My access" page in the navigation (phone friendly). It is the browser side of the
self-service API above and shows only your own rows:

- **My keys**: add a New Relic User key (a password field, checked with New Relic, stored encrypted, never shown again:
  pages show the last 4 characters), rename it, check it again, replace it or delete it (up to 10 keys). Deleting asks
  for confirmation and is refused while one of your grants uses the key.
- **My grants**: the projects an administrator assigned to you. "Change key" points a grant at one of your usable keys
  or back at the project default. Scope (tools, accounts, limits) stays with administrators.
- **My device tokens**: "New device token" asks for a grant, a device name and a lifetime, then shows the token once with
  connect snippets (up to 20 live tokens per grant). Revoking asks for confirmation.

A page or form that names someone else's key, grant or token (a forged link, an edited form) gets the same "Page not
found" answer as one that does not exist, and changes nothing.

## What session cookies never do

- They never authenticate MCP endpoints (`/p/<project>/mcp`) or `/passthrough/mcp`: those take device tokens and
  New Relic keys only.
- They never appear in logs, responses or the audit log. Audit rows name the user (`userId`) and a 16-character
  reference to the session (a prefix of its hash), never the cookie.
- An expired, revoked or unknown session gets the same `401` as a missing admin token.
