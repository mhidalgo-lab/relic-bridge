---
id: P4-15
title: "Member self-service screens in the admin panel"
phase: 4
status: review
priority: medium
depends_on: [P4-10, P4-04]
adr: [0009]
owner: "claude-agent"
---

# P4-15 — Member self-service screens in the admin panel

## Goal
P4-10 gave members an API for their own keys, grants and device tokens. A member who signs in to `/admin` still sees
only the overview and the audit page. Give them screens for the BYO-key flow (phone first).

## Scope
- A "My access" area (`/admin/me`, minimum role `member`) built on `kit.page` / `kit.form` and the in-process
  `/me/*` API calls: my keys (add, rename, rotate, revalidate, delete), my grants (use my key, back to default) and my
  device tokens (issue with the one-time token page and connect snippet, revoke). Same conventions as P4-04 (CSRF,
  confirmation for destructive actions, secrets only in POST bodies, one-time handle for the new token).
- Navigation entry for members; the admin-only entries stay hidden.
- P2-12 UI matrix rows (HTTP app and Worker), axe-core on every page and state, member gating tests.

## Design (refined)
Routes, all `kit.page('member')` / `kit.form('member')` (every role, including admins who also hold grants), in
`screens/me.tsx`; every call goes to the P4-10 `/me/*` API, never to the admin lists:
- `GET /admin/me`: three sections: my grants (project, key used, status, links), my keys (masked, status), my device
  tokens (prefix, grant, status, revoke).
- Keys: `GET|POST /admin/me/keys/new` (name, region, password field), `GET /admin/me/keys/:id` (detail built from the
  `/me/credentials` list: the API has no read-by-id), `POST .../rename|revalidate|delete`, `GET|POST .../rotate`.
- Grants: `GET|POST /admin/me/grants/:id`: choose one of my usable keys or the project default.
- Tokens: `GET /admin/me/tokens/new[?grant=]` (two steps), `POST /admin/me/tokens` (single-use handle, one-time page with
  connect snippets, same page as P4-04: extracted and shared), `POST /admin/me/tokens/:id/revoke` (confirmation).
- A page or form naming an id that is not the caller's gets the `404` page (the API answers `404` for both missing and
  foreign rows); nothing changes. Cap and revoked-grant refusals (`409`) show the API's message.
- Nav entry "My access" (`member`); admin-only entries unchanged.

## Acceptance criteria
- [x] A member completes add key, use it on their grant and issue a device token in the browser.
- [x] A forged form post naming another user's key, grant or token changes nothing (`404` page).
- [x] UI matrix rows and axe-core pass.

## Security notes
T3, T13, T14: the pages hold no ownership logic; the API decides.

## Docs to update
- `docs/dev/admin-ui.md`, `docs/guide/admin-access.md`.

## Out of scope
- Members creating their own grants.
