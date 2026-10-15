---
id: P8-67
title: Deprecated-config registry with startup warnings and doctor lines
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-67 — Deprecated-config registry with startup warnings and doctor lines

## Goal
Configuration names (environment variables and settings) will be renamed or removed over time, and the versioning policy
(PR #236, `docs/guide/versioning.md` once merged) promises a deprecation window. Today there is no list of deprecated
names: nothing warns an operator who still uses one and `doctor` cannot report it. Warnings are ad hoc strings pushed to
the `warnings` array in `apps/cli/src/serve.ts`.

## Scope
- One registry (typed list, web-standard so the Worker can import it, e.g. in `packages/core` or `packages/http-app`):
  name, kind (env var, setting, CLI flag), replacement, deprecated-in version, removal version, doc link. Start with the
  names that are really deprecated when this lands (check the changelog and guides; do not invent entries).
- `relic-bridge serve`: one stderr warning per deprecated name in use, at startup (`logger.warn` in
  `apps/cli/src/main.ts` already prints the `warnings` list).
- stdio mode (`apps/cli/src/stdio.ts`): the same warning at startup, stderr only.
- Worker: one log line per deprecated variable present in `env` at boot (`parseWorkerSettings`,
  `apps/worker/src/settings.ts`), once per isolate, not per request.
- `doctor` (`doctorCommand` in `apps/cli/src/manage/doctor.ts`): one warn line per deprecated name in use, with the
  replacement.
- A test that fails when an entry lacks replacement text or its removal version is at or below the current version.

## Acceptance criteria
- [x] Registry exists with unit tests for its shape and the "already removed" guard.
- [x] `serve`, stdio and the Worker each warn once per deprecated name in use (tests with a fake entry).
- [x] `doctor` prints one warn line per deprecated name, passed through the same scrubber as its other lines.
- [x] Only the name is logged, never the value.
- [x] `docs/guide/versioning.md` links to the registry (or a note is left in the PR if the guide is not merged yet).

## Outcome
- Registry: `DEPRECATED_CONFIG` in `packages/core/src/deprecations.ts` (kinds `env`, `yaml` dotted path with `*`,
  `flag`). It ships **empty**: no configuration name is deprecated today (the only deprecation, `whoami`
  `limits.callBudget`, is a tool output field). Every consumer takes an injected registry, and the tests use fake entries.
- Wiring: `serveSettings` (env + argv), stdio in `main` (env + argv before config loads, YAML keys after),
  `parseWorkerSettings` (logged by the existing once-per-boot warning loop), `doctor` check `deprecated-config`
  (one `ok` line when nothing is in use, so every `doctor` run now has one more line).

## Security notes
T28 (diagnostics leak): names only, never values (a deprecated setting may hold a secret). T30: nothing is exported over
OTLP.

## Docs to update
- `docs/guide/configuration.md`, `docs/guide/troubleshooting.md`, `docs/reference/cli.md` (doctor output),
  `docs/guide/versioning.md` when it exists, changeset.

## Out of scope
- Deprecating any particular name; automatic config migration.
