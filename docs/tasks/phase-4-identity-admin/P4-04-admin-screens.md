---
id: P4-04
title: "Admin screens: credentials, projects, grants, tokens, users"
phase: 4
status: review
priority: high
depends_on: [P4-03]
adr: [0008]
owner: "claude-agent"
---

# P4-04 — Admin screens: credentials, projects, grants, tokens, users

The everyday management screens of the admin panel, built on the P4-03 frame (`packages/admin-ui`, one file per screen,
`kit.page` / `kit.form`, data only through the in-process admin API so validation, roles and audit stay in one place).
Every screen is for `admin` and `owner`; members get the `403` page (member self-service is P4-10).

## Scope
- **Credentials** (`/admin/credentials`): masked list (label, region, owner, `…last4`, validation status, New Relic
  user, reachable accounts); add (label, region, owner or shared, key in a `type=password autocomplete=off` field;
  validated live by the admin API, then the detail page shows the New Relic user email and reachable accounts);
  detail with rename, re-check against New Relic, rotate (new key + explicit confirmation; warns when the key
  belongs to another New Relic user) and delete (confirmation; refused while a project or grant uses it). A key is
  never shown again, never put back into a re-rendered form, never in a URL, flash or log.
- **Projects** (`/admin/projects`): list (slug, MCP endpoint, accounts, tools, status); create in two steps without
  JavaScript: pick the default credential (its region shown; the region comes from the credential), then the account
  picker from that credential's reachable accounts (default account + allowed accounts), the tools checklist grouped
  by category with read/write badges ("all tools, including later ones" or an explicit list), and query limits; detail
  with the same edit form, the project's grants, disable/enable and delete (confirmation).
- **Grants** (`/admin/grants`): list with project/user filters; create for a user or a service (label), with the
  credential (project default, a shared key, or that user's own key: BYO-key), tool and account subsets limited to
  what the project allows, rate limit and expiry; detail showing parts the project does not allow ("no effect"), its
  device tokens, revoke and delete (confirmation).
- **Tokens / devices** (`/admin/tokens`): list (prefix, label, grant, created, expires, last used, status) with a
  grant filter; create (grant, device label, lifetime incl. "never" with a warning); the new token is shown **once**
  on a dedicated `200` response page (`Cache-Control: no-store`, copy button, guidance), never in a redirect, flash
  or log; revoke with confirmation. Connected OAuth clients arrive with Phase 5 (not here).
- **Users** (`/admin/users`): list; invite (pre-create the user: the user row is the explicit allow for sign-in, see
  P4-01) with role (owner only offered to owners); detail with role change, disable/enable and "sign out everywhere"
  (confirmation), their keys and grants. No controls for changing one's own role or disabling oneself.
- **Shared rules**: cursor pagination on every list; empty states; phone-first layouts; destructive actions
  (revoke, delete, disable, key rotation) need an explicit confirmation that the server checks (`confirm=yes`): the
  disclosure on detail pages, or a confirmation page answered to a POST without it; admin API answers mapped
  to the UI (`400` field errors on the form, `409`/`422` messages, `502` "New Relic could not be reached, nothing
  changed", `404`/`403` flashes, `429`/`503` error pages); warnings shown.
- **Wiring**: the tool catalogue (name, title, group, kind) and the public URL reach the UI through `AdminUiDeps`;
  every new route in the P2-12 matrix (`UI_ROUTES`) and the axe-core suite.

## Acceptance criteria
- [x] Every screen above renders for admins and owners, is `403` for members, and has an empty state and pagination
      where it lists rows.
- [x] Form flows tested against the in-process app with storage (Node and Worker hosts): CSRF/origin failures refused
      and audited, role gating, validation errors re-rendered without echoing a key, confirmation required for every
      destructive action.
- [x] End-to-end personal setup through the UI forms only (HTTP, no JavaScript needed): 2 credentials (US and EU),
      2 projects, 3 device tokens; each token appears exactly once in all responses (its one-time page) and works on
      the MCP endpoint; the P2-12 leak scan finds no key, token hash or session secret anywhere.
- [x] axe-core passes on every new page and state; every new route is in `UI_ROUTES` (strangers → sign-in).
- [x] Docs: admin guide for the screens (`docs/guide/admin-panel.md`), `docs/dev/admin-ui.md`, THREAT_MODEL.

Refinement (2026-10-03, autonomous run): the original criterion was a Playwright browser E2E. The panel needs no
JavaScript, so the same flow is driven over HTTP in the P2-12 harness (both hosts) here; a real-browser run and the
guide screenshots moved to P4-11 (pending decision in `docs/pending-decisions/phase-4.md`).

## Security notes
T3 (no cross-tenant choices offered; the API decides), T8 (keys and tokens never echoed or logged; tokens once),
T13 (CSRF on every form, escaping, confirmations), T14 (session only).

## Docs to update
- `docs/guide/admin-panel.md` (new), `docs/dev/admin-ui.md`, `docs/THREAT_MODEL.md`, `docs/guide/admin-access.md`.

## Out of scope
- Member self-service (P4-10), audit viewer (P4-05), connect snippets (P4-06), connected OAuth clients (Phase 5),
  master-key rotation screen (CLI / API), editing a grant in place (the API has no grant update: revoke and recreate),
  Playwright run and screenshots (P4-11).
