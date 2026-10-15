---
id: P8-95
title: ASVS refresh after P8-65/66/73 and the documentation-only open items
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-95 — ASVS refresh after P8-65/66/73 and the documentation-only open items

## Goal
`docs/security/asvs-l2.md` still lists as partial three items that have since been fixed: HSTS (V3.4.1, P8-66), recent
sign-in for sensitive admin actions (V6.8.4, V7.5.1, P8-73) and remembered consent for unassured clients (V10.7.1,
P8-65). Its documentation-only open items can be closed by writing the missing sections.

## Scope
- Re-check V3.4.1, V6.8.4, V7.5.1, V7.5.2 and V10.7.1 against the code and tests, and update the status, evidence and
  chapter counts.
- Write the missing documentation:
  - V7.1.1: risk justification for the session timeouts (`docs/guide/admin-access.md`)
  - V7.1.3: the relic-bridge session is independent of the IdP session, and there's no back-channel logout
    (`docs/guide/identity-providers.md`)
  - V8.1.2: one field-level rules section (who sees which fields)
  - V13.1.1: one list of outbound destinations (NerdGraph regions, IdP and JWKS, metadata documents, OTLP, `doctor`)
  - V14.1.2: one data protection table per data class (encryption, retention, logging)
  - V15.1.1 / V15.2.1: remediation time frames per severity for third-party advisories (`SECURITY.md`), and say
    whether moderate advisories are gated
- Update the "Open items" list. Keep "Platform or design" items as recorded limits.

## Acceptance criteria
- [x] Every status change cites code and a test.
- [x] Every new doc section linked from the ASVS row.
- [x] Chapter totals add up.

## Security notes
Documentation only. Don't describe CI runner infrastructure.

## Docs to update
- `docs/security/asvs-l2.md`, `SECURITY.md`, the guides named above, THREAT_MODEL if a statement changes.

## Out of scope
- Product changes (P8-96).

## Outcome
- Rows changed: V3.4.1, V7.5.1 and V10.7.1 partial to met; V6.8.4 and V7.5.2 stay partial with a narrower gap; V7.1.1,
  V7.1.3, V8.1.2, V13.1.1, V14.1.2, V15.1.1 and V15.2.1 partial to met (documentation).
- New: `docs/security/data-protection.md` (field-level rules, outbound destinations, data classes); "Why these
  timeouts" in the admin access guide; IdP session independence in the identity providers guide; "Advisories in
  third-party components" in `SECURITY.md`.
- The third-party time frames are a proposal: see `docs/pending-decisions/phase-8.md`.
