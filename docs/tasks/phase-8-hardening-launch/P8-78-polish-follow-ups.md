---
id: P8-78
title: Polish - golden-metric trend note, timeout recipe, deprecated alias schema, upgrade steps
phase: 8
status: todo
priority: low
depends_on: [P8-52]   # P8-60 (PR #229): add once it is on main
adr: []
owner: ""
---

# P8-78 — Polish: golden-metric trend note, timeout recipe, deprecated alias schema, upgrade steps

## Goal
Four small inconsistencies, three of them follow-ups of recent tasks.

1. **Golden-metric note (follow-up of P8-60, PR #229).** `packages/core/src/tools/golden.ts` adds the result-level
   adjustment "Trend compares the halves of the window: the previous window is beyond the window limit." whenever the previous
   window is beyond the limit. It says "halves" even when a metric's trend ends up unknown (no fallback possible), so the
   note describes a comparison that did not happen. Make the note match what each metric got (halves, or unknown).
2. **Timeout recipe (follow-up of P8-52).** The observability guide's timeout query is
   `… message = 'mcp request timed out' FACET mcpMethod …`. `FACET mcpMethod` drops records without the attribute. The
   recipe should also facet by `service.version`, and keep records without `mcpMethod` visible (for example
   `FACET mcpMethod, service.version` with a note, or `FACET cases(...)` / `if()` to label missing values).
3. **Deprecated `callBudget` alias.** `whoami`'s `limits.callBudget` (`packages/core/src/tools/identity.ts`) is marked
   deprecated only in its description. Also emit JSON Schema `deprecated: true` (zod 4 `.meta({ deprecated: true })`) so
   clients and schema tooling see it; keep the value unchanged; check the generated tool docs and schema snapshots.
4. **Upgrade steps disagree.** `docs/guide/cloudflare-deploy.md` ("Updating") says `git pull` (on whatever is checked out,
   typically `main`), while `docs/guide/self-hosting.md` ("Upgrading") only says "deploy the new version" and the release flow
   works in tagged versions. No guide currently tells a source user to check out a release tag. Align them: check out the
   release tag you want (for example `git fetch --tags && git checkout v<version>`), then install and `pnpm cf:setup`; make
   the self-hosting section say the same for source installs. Also fix the other `git pull` mentions in the Cloudflare guide
   (the `wrangler.local.jsonc` drift notes).

## Acceptance criteria
- [ ] Golden-metric notes are accurate per metric: halves note only when halves were used; an unknown trend says so (test in
      `packages/core/test/tools-golden.test.ts`).
- [ ] The timeout query in `docs/guide/observability.md` facets by `service.version` and runs against a live export (leave
      unticked until checked).
- [ ] The `whoami` output schema marks `callBudget` `deprecated: true`; the value and the description are unchanged (test on
      the schema; regenerate `docs/reference/tools.md`).
- [ ] Both guides give the same upgrade steps, and the Cloudflare guide no longer tells users to pull `main`.

## Security notes
None (documentation, messages and one schema annotation).

## Docs to update
- `docs/guide/observability.md`, `docs/guide/cloudflare-deploy.md`, `docs/guide/self-hosting.md` if needed,
  `docs/reference/tools.md` (generated), changeset.

## Out of scope
- Removing the `callBudget` alias (scheduled by its own deprecation notice); other golden-metric behaviour.
