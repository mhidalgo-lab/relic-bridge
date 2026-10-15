---
id: P8-01
title: "Threat model final review and fuzzing"
phase: 8
status: done
priority: high
depends_on: [P7-04, P7-09]
adr: []
owner: claude-agent
---

# P8-01 — Threat model final review and fuzzing

## Goal
Before the independent review (P8-02) and the 1.0 launch, every threat in `docs/THREAT_MODEL.md` must be backed by
code and tests that exist today, or be written down as an accepted risk. A reviewer should be able to go from any row
to the code and the tests that prove it, and from any relevant OWASP ASVS requirement to its evidence.

## Scope
- **Threat model walk.** For every threat T1–T33 (section 4) and every checklist item (section 5): check the stated
  mitigation against the current code on `main`. Each row ends in one of three states:
  - *verified*: the mitigation exists; the doc names the code and the tests that prove it;
  - *corrected*: the doc was stale or wrong and is fixed to match the code;
  - *accepted risk*: the residual risk is stated explicitly, with the reason.
  Code that does not match the threat model is not fixed here: a security issue goes to the owner privately
  (SECURITY.md), anything else becomes a new task.
- **THREAT_MODEL v1.** Versioned header (version, date, review reference), a change summary from v0, a verification
  table (one row per threat: status, code, tests, residual risk), section 5 checklist items ticked only with evidence.
  The per-feature implementation log (section 5a) stays as history.
- **OWASP ASVS 5.0.0 Level 2 checklist** (`docs/security/asvs-l2.md`, version confirmed from the OWASP release page).
  All L1 and L2 requirements of the chapters that apply to relic-bridge: encoding and injection (NRQL, GraphQL),
  validation, web frontend (admin panel, consent page, MCP App view), API and HTTP, authentication with an IdP,
  sessions, authorization, self-contained tokens, OAuth / OIDC, cryptography, communication, configuration and
  secrets, data protection, secure coding and dependencies, logging and error handling. Each item: applies / N/A,
  status (met, partial, not met, accepted), evidence (code, test, doc). Chapters that do not apply (file uploads,
  passwords, WebRTC, …) are listed with the reason.
- **Property / fuzz tests** with `fast-check` (already a dev dependency of `core` and `auth`; added to the packages that
  need it at the same pinned version). Bounded runs in the normal suite; a longer local run through an environment
  variable (`RB_FUZZ_RUNS`). Targets:
  - `nrql` tagged template and `nrql.identifier()`: no breakout for any string, round-trip (the literal or identifier
    decodes back to the input), rejection classes stable;
  - entity guid decoding;
  - configuration / environment parsing (`RB_*` variables, including the OTLP headers list);
  - OAuth inputs: `redirect_uri` matching, PKCE verifier / challenge, `state`, client registration metadata, token
    request parameters;
  - bearer token parsing (`rb_` access tokens, `Authorization` header);
  - `time_range` parsing;
  - MCP JSON-RPC body handling limits (size cap, malformed bodies).

## Acceptance criteria
- [x] Every threat T1–T33 has a status (verified / corrected / accepted risk) with code and test references in the
      THREAT_MODEL verification table; no row relies on a control that is not in the code.
- [x] Section 5 checklist: each item ticked with evidence, or left open with the reason.
- [x] THREAT_MODEL carries a v1 header (version, date) and a change summary from v0.
- [x] `docs/security/asvs-l2.md` covers every L1/L2 requirement of the applicable ASVS 5.0.0 chapters with
      applicability, status and evidence; excluded chapters listed with a reason.
- [x] Property tests for each target above run in `pnpm test` (bounded, fast) and accept `RB_FUZZ_RUNS` for longer runs.
- [x] Findings: security issues reported to the owner privately (not in the repository); non-security bugs filed as
      new task files or listed for the owner.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
All threats. This task changes documentation and tests only; no runtime behaviour changes. Vulnerabilities found
during the walk are not described in this repository (SECURITY.md).

## Docs to update
- `docs/THREAT_MODEL.md` (v1).
- `docs/security/asvs-l2.md` (new).
- `docs/dev/testing.md` (property and fuzz tests, `RB_FUZZ_RUNS`).
- Small corrections found by the walk: `docs/guide/security-basics.md` (four write tools, "Read-only by default"),
  `docs/security/best-practices-answers.md`, `SECURITY.md` (links).

## Out of scope
- Fixing issues found by the walk (owner, privately; or new tasks).
- The independent review itself (P8-02).
- ASVS Level 3 requirements.
