---
id: P5-05
title: "Token lifecycle: expiry, refresh rotation, revocation"
phase: 5
status: todo
priority: high
depends_on: [P5-04]
adr: []
owner: ""
---

# P5-05 — Token lifecycle: expiry, refresh rotation, revocation

## Scope
- Access-token TTL by plan: 8 h on `RB_PLAN=free` (KV write quota), 1 h on paid (ADR-0009).
- Short-lived access tokens (e.g. 1 h), rotating refresh tokens with reuse detection, revocation endpoint, admin revoke per client/device, revoke-all on grant revoke.
- (from P5-04) The device list can show the label the user typed on the consent page (provider grant metadata
  `{ label }`); revoking a device should also delete the user's remembered approval for that client
  (`oauth-consent:<userId>:…` rows, see `docs/dev/oauth.md` §Consent screen) and the remembered-apps page
  (`/oauth/approvals`) could merge into the device list.

## Acceptance criteria
- [ ] Refresh reuse → family revoked (test).

## Security notes
T15.

## Docs to update
- OAuth guide.

## Out of scope
- —
