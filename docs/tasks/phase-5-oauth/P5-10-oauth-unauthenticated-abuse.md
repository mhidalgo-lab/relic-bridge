---
id: P5-10
title: "Bound what anonymous callers can do to registration and CIMD"
phase: 5
status: review
priority: medium
depends_on: [P5-03, P5-08]
adr: [0012]
owner: claude-agent
---

# P5-10 — Bound what anonymous callers can do to registration and CIMD

## Goal
Phase 5 review M1, L3, L4, L5 (`docs/reviews/phase-5-review.md`): the unauthenticated OAuth endpoints are bounded,
but one source can still lock everyone else out of dynamic registration, fill the client list and make the server
fetch arbitrary public URLs.

## Scope
- **M1 DCR lockout.** The registration cap is one deployment-wide fixed window (`RB_OAUTH_DCR_LIMIT`, 30 per hour)
  behind a per-IP rule of 60 per 5 minutes: 30 anonymous registrations from one IP in the first seconds of the hour
  make every legitimate registration a `429` until the next window (review probe). Add a per-IP registration counter
  in `kv` (a few per hour) checked before the global one; count only registrations the provider accepted; consider
  headroom for loopback or `RB_OAUTH_DCR_REDIRECT_HOSTS` redirects.
- **L3 client list truncated before sorting.** `clients.list()` (`packages/http-app/src/oauth/server.ts`) stops at
  `MAX_OAUTH_CLIENTS_LISTED` (500) in key order, then sorts newest first: a flood (unused registrations live 24 h)
  can hide a real client from the owner's panel. Sort over a bounded scan or paginate; show "more" when truncated.
- **L4 CIMD records and fetches are uncapped.** Each distinct client id URL on `/oauth/authorize` or `/oauth/token`
  is fetched and, when valid, stored (`client:` rows, 5 min-24 h), with no global cap (60 anonymous requests left 60
  rows and 60 outbound fetches); failures are not cached, so one IP can make about 12 outbound requests per minute to
  public hosts. Add a per-IP fetch budget and a cap on stored document clients.
- **L5 the `oauth` rule is per isolate on Workers.** `oauth:` is not in `SHARED_KEY_PREFIXES`
  (`apps/worker/src/rate-limit.ts`), like `signin:` (P4-20). Share it (a second Rate Limiting binding with a stricter
  rule, or the P7-10 limiter) or document it as best effort everywhere it is described.

## Acceptance criteria
- [x] 30 registrations from one IP leave registration open for another IP (memory, SQLite, D1).
- [x] The owner's client list shows the newest clients first even with more than 500 records.
- [x] Anonymous authorize requests with N distinct document URLs from one IP cause at most the budgeted fetches and
      stored rows.
- [x] Workers: the `oauth` rule holds across isolates, or the docs say it does not. (Documented as per isolate, best
      effort; the registration and fetch bounds are shared storage counters.)

## Security notes
T10 (DCR flooding), T11 (CIMD fetches), T20 (resource exhaustion). Update THREAT_MODEL.

## Docs to update
- `docs/dev/oauth.md` (§Client registration, rate limits), `docs/guide/oauth.md`, THREAT_MODEL T10/T11.

## Out of scope
- Durable Object rate limiter (P7-10).
