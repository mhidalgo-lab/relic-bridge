---
id: P8-99
title: Fix the open CodeQL code-scanning alerts
phase: 8
status: in-progress
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-99 — Fix the open CodeQL code-scanning alerts

## Goal
Close the open CodeQL alerts (#10 to #26) by fixing the code, not by dismissing them.

## Scope
| Alert | Rule | File | Outcome |
|---|---|---|---|
| #25, #24 | js/file-system-race | `packages/storage-sqlite/src/file.ts` | Real (local, low). Files are created with `O_CREAT|O_EXCL|O_NOFOLLOW` at `0600`; an existing file is opened once, `fstat`-ed and `fchmod`-ed through the handle; the backup maps `EEXIST` to the conflict error. |
| #23 | js/file-system-race | `apps/cli/test/manage.test.ts` | Test: mode and content read through one fd. |
| #14 | js/redos | `packages/auth/src/crypto/bytes.ts` | Real, exponential. One character class instead of two overlapping alternatives; mixed alphabets are still rejected by the existing check. Reachable by an authenticated admin only. |
| #13 | js/polynomial-redos | `packages/http-app/src/telemetry.ts` | Real, quadratic; operator configuration only. Linear trim. |
| #11 | js/polynomial-redos | `packages/core/src/nerdgraph/entity-query.ts` | Real, quadratic in theory; values are quoted and length-capped, so not practically reachable. Linear scanner. |
| #10 | js/polynomial-redos | `packages/admin-ui/src/snippets.ts` | Real, quadratic; operator configuration only. Linear trim. |
| #18 | js/incomplete-sanitization | `packages/core/src/output/format.ts` | Real (low): a backslash before `|` could end a table cell. Backslashes escaped first. |
| #20, #15 | js/incomplete-sanitization, js/identity-replacement | `scripts/gen-tool-docs.ts` | Fixed: backslash escaping; no-op replace removed. Docs regenerated (no diff). |
| #19 | js/incomplete-sanitization | `packages/http-app/test/admin-docs.test.ts` | Test code: backslash escaping. |
| #22, #17 | js/incomplete-url-substring-sanitization, js/double-escaping | `packages/http-app/test/authz/consent-suite.ts` | Test code: parse the URL and compare the host; single-pass entity decode. |
| #21 | js/unvalidated-dynamic-method-call | `apps/cli/test/cimd-fetch.test.ts` | Test code: iterate the registered handlers. |
| #16 | js/bad-tag-filter | `scripts/test/chart-app.test.ts` | Test code: case-insensitive. |
| #26 | js/http-to-file-access | `spikes/nerdgraph/lib.ts` | Spike (redacted probe output, never shipped): excluded with `paths-ignore` in `.github/codeql/codeql-config.yml`. |

## Acceptance criteria
- [x] Every alert above fixed or excluded, outcome recorded in the table.
- [x] Adversarial-input tests with a time bound for #14, #13, #11, #10; symlink and permission tests for #24 and #25.
- [x] THREAT_MODEL T35 added (sections 4, 4a, 5a); patch changeset.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
T35. No alert is reachable by an unauthenticated caller or a token holder. #14 was exponential and reachable by an
authenticated admin (`wrapKey`, imported bundle fields); no advisory.

## Docs to update
- THREAT_MODEL, changeset.

## Out of scope
- Scorecard alerts (#1, #6, #7).
