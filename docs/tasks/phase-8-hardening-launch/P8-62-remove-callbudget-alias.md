---
id: P8-62
title: Remove the deprecated whoami limits.callBudget alias in 0.11.0
phase: 8
status: in-progress
priority: low
depends_on: [P8-05, P8-47]
adr: []
owner: claude-agent
---

# P8-62 — Remove the deprecated whoami limits.callBudget alias in 0.11.0

> **Start after 0.10.0 is published.** The alias was announced in 0.9.1 (P8-47, changeset `0c719e6`) as "removed in the
> minor after next": 0.10.x keeps it, 0.11.0 removes it ([versioning policy](../../guide/versioning.md#deprecations)).
> Merging this before the 0.10.0 release would ship the removal one minor early. Check `apps/cli/CHANGELOG.md` for a
> `## 0.10.0` heading (or `git tag --list v0.10.0`) first, and make sure the release that takes this change is a minor
> (0.11.0), never a 0.10.x patch.

## Goal
Finish the deprecation of `whoami.limits.callBudget` on schedule, as the policy says: the duplicate field goes away in
the announced release, with a release note that names the replacement, so a script that still reads it has had two
minors of warning.

## Scope
- `packages/core/src/tools/identity.ts`: remove `callBudget` from the `whoami` output schema and from the structured
  result; keep `perCallBudget` and its description unchanged.
- Tests: drop or invert the assertions that expect `callBudget` (core `whoami` tests, any snapshot or eval that lists
  the field); add one that `limits` has no `callBudget`.
- Regenerate `docs/reference/tools.md` (`pnpm docs:tools`).
- Changeset (`minor`), worded as the announced removal: "**Breaking**: removed `whoami` `limits.callBudget`
  (deprecated in 0.9.1, announced for removal in 0.11.0); read `limits.perCallBudget`, which has the same value.
  Reconnect your MCP client after upgrading."
- `docs/guide/versioning.md`: move the row out of "Current deprecations" (or mark it removed in 0.11.0).
- `docs/guide/upgrading.md`: a `0.10.x → 0.11.0` note with the same line.

## Acceptance criteria
- [ ] 0.10.0 is published (CHANGELOG or tag) before this is merged; the PR description says which release takes it.
- [ ] `whoami` returns `limits.perCallBudget` and no `limits.callBudget`; the output schema no longer lists it.
- [ ] Tests updated; a test asserts the alias is gone. The `tools/list` size budget test still passes.
- [ ] `docs/reference/tools.md` regenerated; the policy's deprecations table and the upgrade notes updated.
- [ ] Changeset is `minor`, marked **Breaking**, and names the 0.9.1 announcement and the replacement.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
None: an output field that duplicates another is removed; no input, access or limit changes.

## Docs to update
- `docs/reference/tools.md` (generated), `docs/guide/versioning.md`, `docs/guide/upgrading.md`, changeset.

## Out of scope
- Restoring `callsUsed` / `callsRemaining` (removed in 0.9.0 on purpose, see P8-39 and P8-47).
- Any other deprecation (each gets its own removal task).
