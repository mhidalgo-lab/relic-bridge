---
id: P5-09
title: "Decide and handle concurrent refreshes from real clients"
phase: 5
status: review
priority: medium
depends_on: [P5-06]
adr: [0009, 0011, 0013]
owner: claude-agent
---

# P5-09 — Decide and handle concurrent refreshes from real clients

## Goal
Make sure a real client that refreshes more than once at a time is not signed out by strict refresh rotation (P5-05),
without giving a stolen refresh token a free window.

## Background
P5-06 measured the official SDK client (`@modelcontextprotocol/client` 2.2.0): it does not coalesce refreshes; three
parallel tool calls over an expired access token send several refresh requests with the same refresh token, and
P5-05's strict single use revokes the whole device. Claude (web, Desktop, mobile) refreshes proactively and on `401`
(vendor docs), so an overlap is plausible. The owner's main goal is Claude on the phone and claude.ai: a server that
disconnects real clients on normal concurrent use is a product blocker. The owner was away (autonomous run): the
choice below is made reversible and logged as a pending decision.

## Scope
- ADR-0013 (supersedes the "strict single use" part of the P5-05 design, not ADR-0009/0011 history): a **refresh
  token reuse interval** (industry practice: Auth0 "reuse interval", Okta "grace period for token rotation").
  - Option `refreshReuseWindowSeconds` (0-120) and variable `RB_OAUTH_REFRESH_REUSE_WINDOW`; **default 30 s**; `0` =
    strict P5-05 behaviour.
  - Re-presenting the refresh token that was just rotated, within the window, by the **same client** (same
    `client_id`, same client authentication, same `resource` and `scope` parameters) returns the **already issued
    successor** pair (idempotent replay): nothing new is minted, so one rotation never forks into parallel families.
  - The successor response is stored **encrypted** (AES-256-GCM, key derived with HKDF from the presented refresh
    token itself, AAD binding user, provider grant and token hash), never in plain text, and expires with the window.
  - A request that arrives while another request is rotating the same token waits for that rotation (bounded,
    ≈3 s) and then gets the replay.
  - Still reuse → family revocation + `oauth.token.reuse` audit: outside the window, an older generation (the successor
    was itself rotated since), another client id / failed client authentication, another resource or scope, a revoked
    device.
  - Replays are audited (`oauth.token.replay`) and logged.
  - Atomic on SQLite and D1 (the existing `kv.take` marker still elects one rotation).
- Tests: P5-05 lifecycle suite (memory, SQLite, D1): parallel refreshes (many) → one rotation, every caller gets the
  same pair, the device keeps working; strict mode keeps the P5-05 behaviour; reuse after the window, older
  generation, other client revoke; nothing stored in plain text. P5-06 conformance suite: the SDK's parallel-refresh
  case keeps the device by default and revokes it in strict mode.
- Settings parsing, `--help`, guides.

## Acceptance criteria
- [x] ADR-0013 with the decision, the measured client behaviour and the default.
- [x] Conformance suite: parallel requests over an expired token keep the device by default; strict mode (`0`) revokes it.
- [x] Reuse of a token outside the window still revokes the device (test); so do an older generation and another client.
- [x] Concurrent refreshes (≥ 8) on memory, SQLite and D1: exactly one rotation, all callers get the same successor.
- [x] The replay cache holds no plain-text token (test scans `kv`).
- [x] `RB_OAUTH_REFRESH_REUSE_WINDOW` parsed and documented (guides, `--help`); THREAT_MODEL T9/T15 updated.
- [x] Pending decision logged for the owner (default 30 s vs strict).

## Security notes
T9 (token theft), T15 (revocation timing): any window is a window for a stolen refresh token. Bounded: only the token
that was just rotated, only for the window, only the already issued pair (no new family), only for the same client;
an attacker who presents it within the window gets the same tokens the client got (no more), and any later reuse is
still detected. Public clients have no client secret, so "same client" is not a proof of possession for them.

## Docs to update
- `docs/dev/oauth.md`, `docs/guide/oauth.md`, `docs/guide/self-hosting.md`, `docs/guide/cloudflare-deploy.md`,
  `docs/reference/client-compatibility.md`, THREAT_MODEL, `docs/adr/README.md`, pending decisions.

## Out of scope
- Anything not about concurrent refresh (lost code-exchange responses stay strict, P5-01).
- Real-client verification (P5-06 checklist).
