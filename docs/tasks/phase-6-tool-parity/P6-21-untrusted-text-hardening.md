---
id: P6-21
title: "Untrusted-text and scope hardening follow-ups from the Phase 6 review"
phase: 6
status: todo
priority: medium
depends_on: [P6-19]
adr: []
owner: ""
---

# P6-21 — Untrusted-text and scope hardening follow-ups from the Phase 6 review

## Goal
Phase 6 review M3-M5, L1-L3 (`docs/reviews/phase-6-review.md`): smaller gaps in redaction, envelope coverage and account
scope that the review did not fix in place.

## Scope
- **Error-text redaction.** Errors Inbox `message`, span / `TransactionError` `error.message`, synthetic `lastError` get
  only the central `redact()` (`cleanName`), not the log patterns of `cleanLogMessage` (URL `user:pass@`, JWT, cloud and
  VCS tokens, PEM). Example passing today: `connect failed postgres://app:S3cret@db`. Synthetic `monitoredUrl` can carry
  `https://user:pass@host`. Decide with the P6-06 (c) question whether the patterns move into `redact()`.
- **`Note:` lines** in tools and composites carry redacted New Relic error messages outside the envelope (pattern older
  than Phase 6). Envelope them or replace with the error code.
- **`structuredContent`** carries cleaned but not enveloped New Relic text. Document the residual for clients that pass
  structured content to the model, or add a `_untrusted` marker field.
- **Golden-metric NRQL** runs with `runTrustedNrql` even when the connection has `rawNrql: false`; golden metrics can be
  customised in New Relic, and composites widen the reach. Decide: honour `rawNrql`, or validate the NRQL shape.
- **Alert conditions** show a condition's NRQL and `dataAccountId` when that account is outside the connection
  (`alerts.ts`); dashboards withhold the same case.
- **`guidAgrees`** returns true for a GUID that does not decode (`entity-common.ts`); undecodable GUIDs reach
  `resolve_entity` and `get_related_entities` output.

## Acceptance criteria
- [ ] Probe tests: a credential-bearing URL in an error message, a synthetic URL and an NR error message are redacted
      or enveloped in every tool that shows them (extend `packages/core/test/probe-envelope.test.ts`).
- [ ] `rawNrql: false` decision implemented with a negative test.
- [ ] Foreign `dataAccountId` NRQL withheld, with a test.
- [ ] THREAT_MODEL residuals of the Phase 6 review row updated.

## Security notes
T6 (prompt injection), T8 (secrets in telemetry), T3 (account scope).

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/guide/security-basics.md` if `rawNrql` semantics change.

## Out of scope
- Server-side log pattern detection (P6-06 e).
