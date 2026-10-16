---
id: P8-97
title: OAuth leak scan false positive - public token-response fields listed as secrets
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-97 — OAuth leak scan false positive: public token-response fields listed as secrets

## Goal
On PR #281 (docs only) the Node 26 job failed once with `an OAuth secret reached a log line`
(`packages/http-app/test/authz/oauth-suite.ts:292`, run in `apps/cli/test/oauth-sqlite.test.ts`, test "stored OAuth rows
hold the slug and the access grant id only in their expected plaintext fields"). It passed on rerun.

Investigation: not a leak. That test queued every value of the refresh response as a "secret"
(`Object.values(JSON.parse(refreshed.text))`), which includes `token_type` (`bearer`), `expires_in` (`600`), `scope`
and `resource`. The scan then looks for each value as a substring of all log lines. The log lines hold random request
ids (UUIDs, 4 lines of 36 characters, 32 hex digits each), so the three characters `600` occur in one of them in about
1 run in 30. The failure never involved an access token, refresh token or code: the redaction (`rb_` pattern) and the
token format are unaffected.

## Scope
- The suites queue only credentials: `credentialsOf(body)` returns `access_token` and `refresh_token`.
- `client-conformance-suite.ts` no longer queues `''` for a missing refresh token (`includes('')` is always true).
- The scan asserts every queued secret is at least 16 characters (`expectOnlyCredentials`), so a short public value
  cannot be queued again without failing loudly and deterministically.
- A deterministic test (`authz/leak-scan.test.ts`) covers the helper and the guard. The scan itself is not weakened:
  every real credential is still checked against logs and audit rows.

## Acceptance criteria
- [x] `credentialsOf` excludes `token_type`, `expires_in`, `scope` and `resource`.
- [x] A guard fails for a secret shorter than 16 characters or empty.
- [x] Deterministic regression test, no randomness.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
T8. Test-only change: no product code, no change to `redact()`. Real OAuth secrets are not affected by this failure
(43 random base62 characters; the scan still fails the suite on any real credential found in a log or audit row).

## Docs to update
- THREAT_MODEL T8 evidence row (the leak scan lists credentials only), empty changeset (test-only).

## Out of scope
- Changing the redaction patterns.
