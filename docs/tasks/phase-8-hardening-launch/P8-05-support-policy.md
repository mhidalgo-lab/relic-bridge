---
id: P8-05
title: "Versioning, support and deprecation policy"
phase: 8
status: review
priority: medium
depends_on: [P7-04, P7-09]
adr: []
owner: claude-agent
---

# P8-05 — Versioning, support and deprecation policy

## Goal
Users and contributors know what a version number promises: what may change in a patch, a minor and a major, before
and after 1.0, how long a deprecated field or setting keeps working, which versions get security fixes, and how to
upgrade. A database created by any published release keeps upgrading to the current schema, proven by a test.

## Scope
- Policy page (`docs/guide/versioning.md`): SemVer rules for every public surface — tool names, input schemas,
  output schemas (structured content), descriptions and text output, prompts and resources, CLI commands and flags,
  env vars and the YAML config, the admin API, the storage schema, the config export file, the published package and
  image, supported Node and MCP protocol versions. What counts as breaking before 1.0 (`0.x`: breaking only in a minor,
  never in a patch) and after 1.0 (only in a major). Must agree with the precedents already shipped: P8-38 (output
  schemas are additive and tolerate new fields; reconnect after upgrading) and P8-47 (`whoami.limits.callBudget` kept
  as a deprecated alias in 0.9.1, removed "in the minor after next", i.e. 0.11.0).
- Deprecation rules: minimum window, how a deprecation is announced (changeset with a `Deprecated:` line, the tool or
  field description, JSON Schema `deprecated: true`, a startup warning for config), and a list of current
  deprecations with their removal version.
- Supported versions and the security-fix backport policy (SECURITY.md).
- Upgrade guide (`docs/guide/upgrading.md`): general steps per deployment mode (stdio/npm, `serve`/Docker, Worker),
  rollback rules, and version-by-version notes for 0.7.0 → 0.8.0 → 0.9.0 → 0.9.1.
- DB upgrade tests: one committed fixture per published minor (0.7, 0.8, 0.9; latest patch of each), generated from the
  migrations embedded in that release's git tag (not written by hand) plus a fixed seed, and a test that upgrades each
  fixture to the current schema on the SQLite adapter (Node) and on D1 (workerd), checks the schema equals a fresh
  database, the seeded rows read back through the adapter, and writes still work. A `--check` mode keeps the fixtures
  in sync with the tags and fails when a published minor has no fixture.

## Acceptance criteria
- [x] `docs/guide/versioning.md` covers every surface above, pre- and post-1.0 rules, deprecation windows and
      announcement channels, supported versions, and lists current deprecations (`whoami.limits.callBudget`).
- [x] The policy agrees with P8-38 and P8-47; the contributor rules are linked from `docs/dev/tool-conventions.md`.
- [x] SECURITY.md "Supported versions" states the backport policy and links the policy page.
- [x] `docs/guide/upgrading.md` with general steps, rollback rules and per-version notes; self-hosting and Cloudflare
      upgrade sections link it.
- [x] `scripts/gen-db-fixtures.ts` generates `packages/storage/test/fixtures/db/v<minor>.json` from the released
      migrations in git history; `--check` runs in `pnpm lint` and fails on a stale or missing fixture.
- [x] Upgrade test on SQLite (`openSqliteStorage`) and on D1 (`createD1Storage`) for every fixture: version current,
      schema identical to a fresh database, seeded rows readable, a write succeeds.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
Security-fix backport policy goes into SECURITY.md. Fixtures hold synthetic rows only (fake ciphertext, a hash of a
made-up token, example.com emails): no real key, token or account id.

## Docs to update
- `SECURITY.md`, `docs/guide/versioning.md` (new), `docs/guide/upgrading.md` (new), `docs/guide/self-hosting.md`,
  `docs/guide/cloudflare-deploy.md`, `docs/dev/storage.md`, `docs/dev/tool-conventions.md`, README docs index.

## Out of scope
- Removing the `callBudget` alias (P8-62, after 0.10.0 is published).
- Upgrade tests for the read-only YAML adapter (its file format is covered by the config schema tests).
- An automated check that changesets mark breaking changes (owner decision).
