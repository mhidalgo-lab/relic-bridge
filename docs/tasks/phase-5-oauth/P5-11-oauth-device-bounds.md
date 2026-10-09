---
id: P5-11
title: "Device replacement policy and complete per-user device bounds"
phase: 5
status: todo
priority: medium
depends_on: [P5-05, P5-08]
adr: [0011]
owner: claude-agent
---

# P5-11 — Device replacement policy and complete per-user device bounds

## Goal
Phase 5 review M2, L6 (`docs/reviews/phase-5-review.md`): make "one OAuth session per device" hold for every client
shape, and make every revoke-all reach every device.

## Scope
- **Replacement policy (M2).** Since the review (H1), redeeming a new code for the same user, client and resource
  (and, for a metadata-document client, the same redirect URI) replaces the earlier devices of that app, as the
  provider did at issuance before. Clients whose installations share one client id and redirect URI are then one
  device: two Claude accounts of one person connecting the same project, or a metadata-document client with a fixed
  https callback used from two machines. Decide (pending decision "P5 review — device replacement") between keeping
  replacement, keeping both devices, or replacing only when the device label matches, and implement it.
- **Bounds (M2).** There is no cap on devices per user at issuance; listing and revoke-all read at most 100
  (`MAX_OAUTH_DEVICES_PER_USER`), so devices beyond 100 are neither shown nor revoked by "disconnect all" (their
  refresh is still refused by the access check only when the grant or user is unusable). Cap devices per user at
  approval (refuse or replace the oldest) so the listing bound is the real bound, or page through all.
- **Client removal (L6).** `clients.remove` deletes the client record, then scans every `grant:` row sequentially and
  throws past 20,000; on D1 a partial run leaves devices of a removed client alive. Make it resumable (the record is
  gone, so a retry must still find the grants: keep a removal marker) or bound it per user.

## Acceptance criteria
- [ ] The chosen replacement policy is tested on memory, SQLite and D1 (including the reconnect case).
- [ ] A user cannot hold more devices than the listing shows; "disconnect all" revokes every one (test with N+1).
- [ ] Removing a client with more grants than one invocation can scan converges on retry.

## Security notes
T9, T15, T20. Update THREAT_MODEL (the P5-05 residual about devices beyond 100).

## Docs to update
- `docs/dev/oauth.md` §Devices, `docs/guide/oauth.md`, `docs/guide/oauth-phone.md`.

## Out of scope
- Per-device rate limits (exist).
