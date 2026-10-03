# Admin UI: conventions for screens

The admin panel is server-rendered HTML under `/admin` (P4-03, ADR-0004). It lives in `packages/admin-ui` (web-standard,
depends on Hono only) and is mounted by `createHttpApp` whenever sign-in is configured, so `relic-bridge serve` and the
Worker serve the same pages. This page is for people adding screens (P4-04 and later).

## Layout of the package

| File | What it holds |
|---|---|
| `src/app.ts` | `createAdminUi(deps)`: the `/admin` sub-app. `registerScreens` lists every screen; the catch-all comes last. |
| `src/kit.ts` | `kit.page`, `kit.form`, `kit.callAdmin`, `kit.redirect`, `adminPath`, `pageFetchProblem`. |
| `src/components.tsx` | `Layout`, `Nav` (`NAV_ITEMS`), `Flash`, `Form`, `TextField`, `SelectField`, `Checkbox`, `Button`, `ConfirmAction`, `SecretOnce`, `DataTable`, `Facts`, `Time`, `localHref`. |
| `src/pages.tsx` | `htmlResponse`, `renderDocument`, `LoginPage`, `MessagePage`, `errorPage`. |
| `src/flash.ts` | The flash catalogue (`FLASH_MESSAGES`, `FlashCode`). |
| `src/headers.ts` | `UI_CSP`, `PERMISSIONS_POLICY`, `UI_PAGE_HEADERS`. |
| `src/screens/*.tsx` | One file per screen, exporting `register<Screen>(ui, kit)`. `overview.tsx` is the reference. |
| `assets/admin.css`, `assets/admin.js` | The only stylesheet and script. Compiled into `src/assets.generated.ts`. |

What the UI needs from the server comes through `AdminUiDeps` (sessions, the in-process admin API call, audit hooks).
`@relic-bridge/http-app` builds it from the P4-02 session manager (`adminUiDeps` in `app.ts`); `admin-ui` never imports
`http-app`.

## Writing a screen

1. Create `src/screens/<name>.tsx` with `/** @jsxImportSource hono/jsx */` under the SPDX line, and export
   `register<Name>(ui: Hono, kit: UiKit)`.
2. Pages: `ui.get('/things', kit.page('admin', async (c, page) => page.html(<Layout …>…</Layout>)))`.
   - `kit.page(minRole, …)` checks fetch metadata, runs the per-IP hook, loads the session (no session: `303` to
     `/auth/login?next=<path>`), checks the role (`403` page, audited) and gives you `page.principal`, `page.flash` and
     `page.html(node, status?)`, which also clears a shown flash.
   - Pass `viewer={page.principal}`, `current="/admin/things"` and `flash={page.flash}` to `Layout`.
3. Forms: build them with `<Form action="/admin/things" csrf={principal.csrf}>`. It posts urlencoded with the CSRF
   field. Handle them with `ui.post('/things', kit.form('admin', async (c, principal, form) => …))`. Before your
   handler runs, the kit checks `Origin` / `Sec-Fetch-Site`, the content type, the size (16 KiB) and the `_csrf` token,
   then the role. Read values from `form.fields` (a `URLSearchParams`; `_csrf` already removed).
4. Data and changes: call the admin API in-process, never storage directly:
   ```ts
   const res = await kit.callAdmin(c, principal, { method: 'GET', path: '/tokens', query: { limit: '50' } });
   const done = await kit.callAdmin(c, principal, { method: 'POST', path: adminPath`/tokens/${id}/revoke` }, form);
   ```
   The admin API runs as the signed-in user, with the same validation, role checks, audit rows and error codes as
   for API clients. GET needs no form. POST, PATCH and DELETE throw unless you pass the `VerifiedForm` of the same
   request, so a handler can't skip the CSRF check. Build paths with `adminPath` so every id is one encoded segment.
   The result is `{ status, body }`; errors are `{ error: { code, message } }` (see `docs/reference/admin-api.md`).
5. After a change, Post/Redirect/Get: `return kit.redirect('/admin/things', 'saved')`. Flash codes come from the
   catalogue in `flash.ts`. Add new codes there (the cookie carries the code, never text). For validation errors,
   render the form again with `error=` on the fields and status `422`.
6. Navigation: add an entry to `NAV_ITEMS` (`href`, `label`, `minRole`).
7. Register the screen in `registerScreens` (`app.ts`), and add each route to the P2-12 matrix
   (`packages/http-app/test/authz/matrix.ts`, `UI_ROUTES`). The guard test fails until you do.

## Rules

- **Escaping.** Strings go into JSX as children or attribute values and are escaped by Hono. Never use `raw()`, the
  `hono/html` helpers or `dangerouslySetInnerHTML`. `node scripts/check-ui-escaping.ts` (part of `pnpm lint`) fails on
  them.
- **Links.** `href` and `action` values go through `localHref` (the components do this for you): same-origin paths
  only. Never build a link from a request value without it.
- **No inline script or style.** The CSP (`UI_CSP`) has no `unsafe-inline` and no nonces. Styles go in
  `assets/admin.css`, behaviour in `assets/admin.js`. After editing either, run `pnpm ui:assets`. The generated file
  carries content-hashed names and SRI. `pnpm lint` fails if it is stale.
- **Works without JavaScript.** The script only enhances (copy buttons). Confirmations use `ConfirmAction`
  (`<details>`), not `confirm()`. `SecretOnce` shows a new secret selectable and adds a copy button when the script
  runs.
- **Accessibility.** Use the components: they label every control, tie hints and errors with `aria-describedby`, give
  tables captions and column scopes, and keep 44 px touch targets. Use real `<button>`s and `<a>`s. Add the new page
  to `test/a11y.test.tsx` (axe-core). New colours go in the token blocks of `admin.css`; `test/contrast.test.ts` checks
  every pair at 4.5:1 in light and dark.
- **Phone first.** Layouts are single-column by default. Tables scroll sideways inside `.table-wrap`. Test at 320 px.
- **Errors.** Throwing gives the generic 500 page with the request id (no message, no stack). Use
  `errorPage(status, requestId, viewer)` for expected 403/404 cases.
- **Role checks.** `kit.page` / `kit.form` gate the page. The admin API checks again on every call, which also makes
  it the source of truth for fine-grained rules (admins vs owners, self-changes).

## Tests

- `packages/admin-ui/test`: components (DOM via jsdom, snapshots, hostile strings), the kit (forms, CSRF, flash,
  `callAdmin`), axe-core on every page, token contrast.
- `packages/http-app/test/authz/ui.test.ts`: the pages in the authorization matrix, on the HTTP app and in workerd.
  Every UI route must send strangers to sign-in and carry the full header set.
- `apps/cli/test/serve-identity.test.ts`: the overview and an asset on a real `serve`.
