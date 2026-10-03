# Admin sign-in: Google, GitHub, Cloudflare Access, OpenID Connect

relic-bridge lets people sign in to its admin side with an identity they already have. This is for **administration**
(the admin panel from Phase 4). MCP clients keep using device tokens until OAuth for MCP clients arrives in Phase 5.

What you get today (P4-01, P4-02):

- `/auth/login`: a page that lists the configured providers.
- Sign-in that ends at a verified, allowed **user record** and then an **admin session** (cookie `__Host-rb_session`)
  that the admin API accepts with the user's role. Sessions, roles, CSRF and sign-out are described in
  [admin access](admin-access.md). The admin panel that uses them comes with P4-03 and later.
- **Setup links**: a single-use, expiring link that makes the first person who signs in through it the `owner`.

Sign-in is **off** until at least one provider is configured. Each provider is one block of variables. The same names
work for `relic-bridge serve` (environment) and the Worker (`vars` plus `wrangler secret put` for the secrets).

## 1. The public URL

Every provider needs `RB_PUBLIC_URL`: the origin browsers use to reach your server, with no path.

| Where it runs | `RB_PUBLIC_URL` | Redirect URI to register at the provider |
|---|---|---|
| Worker | `https://bridge.example.com` (or `https://relic-bridge.<you>.workers.dev`) | `https://bridge.example.com/auth/callback/<provider>` |
| `serve` behind TLS | `https://mcp.example.com` | `https://mcp.example.com/auth/callback/<provider>` |
| `serve` on your machine | `http://localhost:8787` | `http://localhost:8787/auth/callback/<provider>` |

`<provider>` is `google`, `github` or `oidc` (`oidc-<name>` when you set `RB_OIDC_NAME`). The redirect URI must match
**exactly**: scheme, host, port and path. Plain `http` is accepted only for `localhost`, `127.0.0.1` and `[::1]`. With
`serve`, the public URL's host must also be in `RB_ALLOWED_HOSTS`.

## 2. Who may sign in

Access is **denied by default**. Sign-in succeeds when one of these is true:

1. **A user already exists for this identity.** Create users with `relic-bridge user add` or `POST /api/admin/v1/users`
   (email only). The first sign-in with a **verified** email that matches the user binds the user to that provider
   account. After that, the user is found by the provider's stable subject (`sub`, or the GitHub numeric id), not by
   email.
2. **The identity is on the allowlist and auto-provisioning is on.** The allowlist is `RB_LOGIN_ALLOW_EMAILS` (exact
   addresses), `RB_LOGIN_ALLOW_DOMAINS` (exact email domains: `example.com` does not match `sub.example.com`) and
   `RB_LOGIN_ALLOW_GITHUB_ORGS` (active members of these GitHub organizations; GitHub sign-in only). When
   `RB_LOGIN_AUTO_PROVISION` is `member` or `admin`, the user is created with that role on the first sign-in. It is
   never `owner`. With auto-provisioning `off` (the default), the allowlist alone does not let anyone in.
3. **The sign-in came through a setup link** (see below). The identity becomes `owner`.

Always refused:

- an email the provider doesn't mark as verified (for GitHub: the **primary** address must be verified);
- a disabled user;
- an email that belongs to a user who is already bound to **another** provider account. Email alone never moves an
  account to a different identity, so one user signs in with one provider account. Re-binding a user to another
  provider is not available yet (tracked in P4-09); until then, sign in with the provider the user is bound to.

## 3. First owner: setup link

With the admin token, ask for a setup link and open it in a browser:

```bash
curl -s -X POST "$URL/api/admin/v1/setup-links" \
  -H "Authorization: Bearer $RB_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"provider":"google","ttlMinutes":30}'
# → {"data":{"url":"https://bridge.example.com/auth/login/google?setup=rb_setup_…","expiresAt":…}}
```

The account you sign in with becomes `owner` (an existing user is promoted, else one is created). The link works
**once** and expires after `ttlMinutes` (default 60, at most 7 days). Only its hash is stored. Leave out `provider`
to get the provider list instead. Treat the link like a password until it is used.

## 4. Providers

### Google

1. Google Cloud console → **APIs & Services → OAuth consent screen**: user type *External* (or *Internal* for a
   Workspace-only instance), app name, support email. Scopes: `openid`, `email`, `profile`.
2. **Credentials → Create credentials → OAuth client ID** → *Web application*.
   *Authorized redirect URIs*: `<RB_PUBLIC_URL>/auth/callback/google`.
3. Configure:

   ```bash
   RB_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   RB_GOOGLE_CLIENT_SECRET=…            # Worker: wrangler secret put RB_GOOGLE_CLIENT_SECRET
   RB_GOOGLE_HOSTED_DOMAIN=example.com  # optional: only accounts of this Workspace domain
   ```

`RB_GOOGLE_HOSTED_DOMAIN` is enforced on the verified ID token's `hd` claim. It is not just the `hd` hint on the login
page, which a user can remove. A consent screen in *Testing* status only admits its listed test users.

### GitHub

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App** (for an organization: the organization's
   settings). *Homepage URL*: your `RB_PUBLIC_URL`. *Authorization callback URL*: `<RB_PUBLIC_URL>/auth/callback/github`.
2. **Generate a new client secret**.
3. Configure:

   ```bash
   RB_GITHUB_CLIENT_ID=Ov23li…
   RB_GITHUB_CLIENT_SECRET=…
   RB_LOGIN_ALLOW_GITHUB_ORGS=my-org     # optional: members may sign up (with RB_LOGIN_AUTO_PROVISION)
   ```

relic-bridge requests `read:user user:email` (plus `read:org` when organizations are allowlisted) and uses PKCE. The
user id is the numeric GitHub id. Only an **active** organization membership counts: a pending invitation does not.
If an organization restricts OAuth app access, an organization owner must approve the app, or GitHub hides the
membership.

### Cloudflare Access (Workers, or anything behind Cloudflare)

Use this when Cloudflare Access already protects the hostname. Access signs each request's identity into the
`Cf-Access-Jwt-Assertion` header, and relic-bridge verifies that header. It never trusts the header unverified, and it
ignores the `CF_Authorization` cookie.

1. Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**. Domain: your hostname. Path:
   `auth/cf-access` (or `admin` and `auth`). Do **not** put Access in front of `/p/*/mcp`: MCP clients can't complete
   the Access login.
2. Add a policy (for example *Emails* or *Emails ending in*), and the identity providers Access may use.
3. From the application's **Overview**, copy the **Application Audience (AUD) Tag**.
4. Configure:

   ```bash
   RB_CF_ACCESS_TEAM=myteam            # or myteam.cloudflareaccess.com
   RB_CF_ACCESS_AUD=<the AUD tag>
   ```

Then open `<RB_PUBLIC_URL>/auth/cf-access`. The assertion must be signed by the team's keys
(`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), name your team as issuer and your AUD tag as audience,
and not be expired. Service-token requests carry no email and are refused. The Access policy decides who reaches the
page. The rules of section 2 still decide who becomes a relic-bridge user.

### Any OpenID Connect provider (Okta, Entra ID, Auth0, Keycloak, Authentik, …)

1. Register a *web* application (confidential client, authorization code flow) with redirect URI
   `<RB_PUBLIC_URL>/auth/callback/oidc` (or `/auth/callback/oidc-<name>`).
2. Configure:

   ```bash
   RB_OIDC_ISSUER=https://login.example.com/realms/main   # exactly the issuer the provider's discovery document names
   RB_OIDC_CLIENT_ID=relic-bridge
   RB_OIDC_CLIENT_SECRET=…
   RB_OIDC_NAME=corp            # optional: idp "oidc:corp", URL key "oidc-corp" (default "oidc")
   RB_OIDC_LABEL="Corp SSO"     # optional: button text
   RB_OIDC_SCOPES="openid email profile"   # optional; must include openid
   ```

relic-bridge reads `<issuer>/.well-known/openid-configuration`. Its `issuer` must equal `RB_OIDC_ISSUER` character for
character. The provider must:

- support the authorization code flow, PKCE S256 and `client_secret_basic` or `client_secret_post`;
- sign ID tokens with an asymmetric algorithm (RS*, PS*, ES*, EdDSA);
- send `email` and `email_verified: true`, in the ID token or from the userinfo endpoint.

Some providers (Microsoft Entra ID by default, for example) don't send `email_verified`, and their users are refused.
Put Cloudflare Access in front with that provider behind it, or configure the provider to assert verification.

## 5. What is checked (security notes)

- Each login is a **transaction stored in the database** (D1 on the Worker, SQLite on `serve`), never in process
  memory. It holds the PKCE verifier, the `nonce`, the provider and the target path. It is keyed by a hash of `state`,
  expires after 10 minutes, and is **consumed once**, so a replayed callback finds nothing.
- The browser that started the login gets an HttpOnly `__Host-rb_login` cookie (`rb_login` on http localhost).
  Only that browser can finish the login, which blocks login CSRF and session swapping.
- A callback for provider A carrying provider B's state is refused (mix-up). An `iss` callback parameter (RFC 9207)
  must name the configured issuer, and must be present when the provider advertises it.
- ID tokens: signature from the provider's JWKS (cached; refetched when a new key id appears, at most every 30 s),
  never `alg: none` or HMAC, exact issuer, audience = your client id (`azp` checked), expiry with 60 s clock skew,
  issued within 10 minutes, `nonce` equal to the transaction's.
- `next` (where to go after sign-in) only accepts paths on your own origin.
- A successful sign-in replaces whatever session the browser had with a new one (no session fixation), audited as
  `session.create`. See [admin access](admin-access.md) for timeouts, roles and sign-out.
- Every attempt is in the audit log: `auth` / `login.ok` (user id, provider, outcome) or `login.denied` with a stable
  reason (`not_allowed`, `not_provisioned`, `identity_conflict`, `email_unverified`, `wrong_audience`, `unknown_state`,
  …). The browser only sees a generic message and the request id. Codes, tokens, client secrets and setup links are
  never logged.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Provider says `redirect_uri_mismatch` | The registered redirect URI differs from `<RB_PUBLIC_URL>/auth/callback/<provider>` (scheme, port, trailing slash). |
| "This sign-in attempt is invalid or has expired" | The login took over 10 minutes, the callback was reloaded, or it opened in another browser or profile (no binding cookie). Start again. |
| "Sign-in was refused" + `not_allowed` / `not_provisioned` in the audit log | No user for this email and the allowlist or auto-provisioning doesn't admit it. Add the user, or use a setup link for the first owner. |
| `identity_conflict` | The email belongs to a user bound to another provider account. |
| `email_unverified` | The provider doesn't vouch for the email (GitHub: verify the primary address). |
| `hd_mismatch` | Google account outside `RB_GOOGLE_HOSTED_DOMAIN`. |
| Boot error naming `RB_PUBLIC_URL` | Missing, not an origin, plain `http` to a non-loopback host, or its host is not in `RB_ALLOWED_HOSTS`. |
