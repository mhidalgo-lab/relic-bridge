---
id: P1-17
title: CLI warnings and docs accuracy follow-ups from the Phase 1 review
phase: 1
status: done
priority: low
depends_on: [P1-11, P1-14]
adr: []
owner: claude-agent
---

# P1-17 — CLI warnings and docs accuracy follow-ups from the Phase 1 review

## Goal
Close the small CLI and documentation gaps found in the Phase 1 consolidation review
(`docs/reviews/phase-1-review.md`, L-items), so v0.1 users get accurate docs and useful warnings.

## Scope
- `apps/cli/src/config.ts`: warn when the config file is group-readable (`mode & 0o040`), not only world-readable;
  warn when `RB_PROJECT` is set in env mode (no config file), where it is ignored.
- `README.md`: split the feature list into "available in v0.1" and "planned" (hosted mode, `/p/{slug}/mcp`, OAuth,
  tokens, encrypted keys and audit log do not exist yet).
- `docs/guide/troubleshooting.md`: startup failures (exit 1) such as `RB_AUTH_INVALID_KEY` for a non-`NRAK-` key;
  mention `RB_AUTH_UNAUTHORIZED` / `RB_LIMIT_RATE` as hosted-mode codes, or say they are not used in v0.1.
- `docs/guide/configuration.md`: list exactly which env vars YAML mode ignores (`RB_LIMITS_*`, `RB_TOOLS`,
  `RB_ACCOUNTS`, `NEW_RELIC_*`) and which still apply (`RB_LOG_LEVEL`, `RB_PROJECT`); boolean forms accepted by
  `RB_LIMITS_RAW_NRQL`.
- `docs/dev/`: a "Live tests" section (env vars, `pnpm test:live`, the `live` workflow and environment), which P1-12
  asked for.
- `time_range` description says `since_ms` / `until_ms` while `structuredContent` uses `sinceMs` / `untilMs`: align
  the wording.

## Acceptance criteria
- [x] Unit tests for both new warnings (and that they never contain key material).
- [x] Every flag, env var and error code in `docs/guide/*.md` matches the code (re-check after the edits).
- [x] `pnpm docs:tools` regenerated if a tool description changed.

## Security notes
T8: the group-readable warning helps users keep a plaintext key private. Warnings go through the redacting logger.

## Docs to update
- README.md, `docs/guide/configuration.md`, `docs/guide/troubleshooting.md`, `docs/dev/` testing page.

## Out of scope
- Keychain key sources, config auto-discovery (pending decisions P1-11).
