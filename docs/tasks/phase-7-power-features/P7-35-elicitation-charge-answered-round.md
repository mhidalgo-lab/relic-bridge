---
id: P7-35
title: Charge the write rate limit only for the answered elicitation round
phase: 7
status: todo
priority: low
depends_on: [P7-20, P7-24]
adr: ["0015"]
owner: ""
---

# P7-35 — Charge the write rate limit only for the answered elicitation round

## Goal
Owner decision (pending-decisions phase 7, P7-20, 2026-10-09): a confirmed write through elicitation should cost one
unit of the per-grant write bucket (20/hour), not two. Today `packages/http-app/src/rate-limit-hooks.ts` charges the
`write:` rule for every `tools/call` of a write tool, including the first round that only returns `input_required`.

## Scope
- Charge the `write:` bucket only for a write `tools/call` that carries `inputResponses` (or `confirm: true` on a
  non-elicitation path) and is not `dry_run`; the first, question-only round is not charged against `write:`.
- The question-only round is still bounded by the general per-token / per-grant limits (unchanged) so form spam stays
  rate-limited.
- Fail-closed behaviour on limiter errors (P7-24) stays for charged calls.

## Acceptance criteria
- [ ] Elicitation flow: two rounds → one `write:` unit; tests on Node and Workers (DO limiter and binding).
- [ ] `confirm: true` flow and dry runs: unchanged / uncharged as today; negative test that an unanswered first round
      cannot be used to exceed the general limits.

## Security notes
T31 rate limit on writes: the mutation-carrying call is still always charged; update THREAT_MODEL T31 wording.

## Docs to update
- `docs/guide/cloudflare-limits.md`, write-tools guide, ADR-0015 (append an "Update (P7-35)" line).

## Out of scope
- Changing the 20/hour figure.
