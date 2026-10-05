---
id: P5-05
title: "Token lifecycle: expiry, refresh rotation, revocation"
phase: 5
status: in-progress
priority: high
depends_on: [P5-04]
adr: [0009, 0011]
owner: claude-agent
---

# P5-05 — Token lifecycle: expiry, refresh rotation, revocation

## Scope
- **Lifetimes.** Short-lived access tokens (default 1 h) and an **absolute** refresh lifetime (default 30 days from
  the authorization, never extended by refreshing). Both configurable with `RB_OAUTH_ACCESS_TTL` /
  `RB_OAUTH_REFRESH_TTL` on Node and Workers. The original "8 h on `RB_PLAN=free`" preset was motivated by the Workers
  KV write quota (ADR-0009); since ADR-0011 the state is in D1 (100,000 row writes/day on Free), so both plans use the
  same 1 h default (pending decision). An access token never outlives the grant it was issued for (`expiresAt`).
- **Refresh rotation with reuse detection.** Every refresh token is single-use under concurrency on memory, SQLite and
  D1: a marker `oauth-refresh:<sha256(token)>` is consumed with the atomic `kv.take` before the provider sees the
  token, and turned into a "used" mark. Presenting a used (or concurrently raced) refresh token revokes the whole
  token family (the provider grant: every access and refresh token of that device authorization), is audited
  (`oauth.token.reuse`) and answers `invalid_grant`. A refresh token that was never issued for the grant (random
  secret with a known grant id) is refused without revoking anything.
- **Access re-checked on every token issuance.** The code exchange and every refresh run `resolveAccess` for the
  grant the device was approved with; a revoked/expired grant, disabled user or project, deleted project or unusable
  key refuses the token request (`invalid_grant`) and revokes the device (its family).
- **Revoke-all.** Revoking or deleting a grant, disabling a user or deleting a project through the admin API also
  revokes the affected OAuth devices at once (the provider grant metadata records the access grant id).
- **RFC 7009 revocation endpoint** (`POST /oauth/token` with `token`): client authentication per client type (public
  clients: `client_id`; confidential: secret), `200` for unknown, foreign and malformed tokens (no information leak),
  refresh token → whole family; clears this process's access cache.
- **OAuth devices in the admin API and UI.** `GET /me/oauth-devices`, `POST /me/oauth-devices/{id}/revoke` (any
  signed-in role, own devices only), `GET /users/{id}/oauth-devices`, `POST /users/{id}/oauth-devices/{deviceId}/revoke`
  (admins; owners' devices only by owners). Device = provider grant: id `oauth_<grantId>` (the audit `tokenId`), client
  name/kind/host, device label (consent page), project, access grant, created, refresh lifetime end. Revoking a device
  also deletes the user's remembered approval for that client and project (`oauth-consent:<userId>:…`). UI: "Connected
  apps" on `/admin/me` and on a user's page, with confirmation; `/oauth/approvals` stays and is linked.
- Effect timing: everything above takes effect immediately for token issuance; an access token already issued stops
  at its next uncached resolution (this process at once, other processes/isolates within the access cache TTL ≤ 60 s,
  the same guarantee as device tokens, T15).

## Acceptance criteria
- [ ] Access TTL default 1 h, refresh absolute lifetime default 30 days, both settable by variables (tests for the
      parser and for absolute expiry: refreshing does not extend it).
- [ ] Refresh rotation: the new refresh token works once; the old one is refused.
- [ ] Refresh reuse → family revoked (every access and refresh token of the device), audited (test).
- [ ] Concurrent refreshes with one token: at most one succeeds, and the family is revoked (race test on memory, SQLite
      and D1).
- [ ] A forged refresh token for a known grant id revokes nothing.
- [ ] Refresh refused and device revoked when its grant is revoked, user disabled, project disabled/deleted (tests).
- [ ] Revoking a grant / disabling a user / deleting a project via the admin API revokes the user's OAuth devices.
- [ ] RFC 7009: unknown client → `401 invalid_client`; another client's token → `200` and the token still works;
      malformed/unknown token → `200`; own refresh token → family revoked.
- [ ] Device list and revoke in the admin API (OpenAPI regenerated) and UI; members see/revoke only their own,
      admins can't touch owners' devices; revoking deletes the remembered approval. Authz matrix lists the new routes
      and stays green.
- [ ] Docs: OAuth guide, `docs/dev/oauth.md`, THREAT_MODEL (T15/T9), pending decisions.

## Security notes
T15 (revocation latency), T9 (token replay), T25 (grant metadata now also carries the access grant id: opaque id).

## Docs to update
- OAuth guide (`docs/guide/oauth.md`), `docs/dev/oauth.md`, admin API reference (generated), THREAT_MODEL.

## Out of scope
- Admin list of OAuth clients and runtime DCR switch (P5-08).
- A refresh grace window for clients that retry a refresh after a network error (revisit with P5-06 findings).
