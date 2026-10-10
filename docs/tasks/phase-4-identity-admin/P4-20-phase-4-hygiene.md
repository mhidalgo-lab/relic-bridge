---
id: P4-20
title: "Phase 4 test, docs and UI hygiene from the consolidation review"
phase: 4
status: done
priority: low
depends_on: [P4-08]
adr: []
owner: claude-agent
---

# P4-20 — Phase 4 test, docs and UI hygiene from the consolidation review

## Goal
Collect the low-severity quality findings of `docs/reviews/phase-4-review.md` (Q1–Q12) so that tests prove what the
task criteria claim and the guides match the code.

## Scope
- **Tests that cannot fail:** the admin-ui CSP tests compare the header to the exported `UI_CSP` constant
  (`packages/admin-ui/test/app.test.ts`): assert the literal policy once. The SQLite `EXPLAIN` check
  (`packages/storage-sqlite/test/sqlite.test.ts`) runs hand-copied SQL: run the adapter's own statement. P4-03's CPU
  benchmark criterion has no admin or asset scenario in `apps/worker/bench/cpu.bench.ts`: add one. axe `color-contrast`
  is off in jsdom: say so in P4-03 or cover it in Playwright.
- **Coverage gaps:** explicit unauthenticated, CSRF and `Origin` refusals for every `/me/*` route (only `POST /me/tokens`
  has them); a parity test between `UI_ROLE_RANK` / page roles (`packages/admin-ui/src/components.tsx`) and the API's
  `ROLE_RANK` / `requiredRole`.
- **UI after review H1:** admins now get `403 owner` on an owner's keys, grants and tokens; hide those controls for
  admins instead of showing a button that leads to the 403 page.
- **Docs:** `docs/guide/cloudflare-deploy.md#sign-in-on-the-worker` lists the variables `cf:setup --sign-in` does not set
  (allow-lists, `RB_LOGIN_AUTO_PROVISION`, `RB_GOOGLE_HOSTED_DOMAIN`, `RB_SESSION_*`, Cloudflare Access); add
  `RB_SESSION_IDLE_MINUTES` / `RB_SESSION_MAX_HOURS` to `apps/worker/src/env.ts`; reference or stop generating
  `docs/guide/images/projects-{light,dark}.png`; add `snippets.ts` / `snippets.tsx` to `docs/dev/admin-ui.md` (consider
  renaming the component file); fix drifted line references in `docs/reviews/phase-4-admin-security-review.md`; fix the
  `.zap/rules.tsv` 10027 reason (line 2, not 1).
- **Small code edges:** the login-transaction cookie reader takes the first of duplicate cookies while the session reader
  refuses them (`packages/http-app/src/identity.ts`): refuse duplicates too. Consider an `audit.export` row per CSV
  export. Consider sharing the `signin:` rate-limit prefix through the Workers binding (`apps/worker/src/rate-limit.ts`).

## Acceptance criteria
- [x] Each bullet above done or explicitly dropped with a reason in this file.
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers` green.

## Outcome
Done:
- Q1 CSP: `packages/admin-ui/test/app.test.ts` asserts the literal policy once and compares headers to it.
- Q2 `EXPLAIN`: `sqlite.test.ts` captures the SQL the adapter prepares for `auditLog.list({ beforeId })` and explains that.
- Q3 CPU benchmark: `admin.asset` and `admin.overview` scenarios in `apps/worker/bench/cpu.bench.ts`; baseline entries
  were scaled from a run on a faster machine (calibration ratio), refresh with `pnpm bench:cpu --update` on a quiet one.
- Q3 axe contrast: not covered in Playwright; instead stated in P4-03 (jsdom cannot compute it; the tokens are checked by
  `contrast.test.ts` and the pages use only those tokens).
- Q4 parity: `packages/http-app/test/authz/ui-role-parity.test.ts` (rank tables equal; every nav page is reachable
  exactly by the roles the menu shows it to).
- Q5: `member-self-service.test.ts` runs 401 / foreign origin / CSRF refusals over every `/me/*` route of the matrix.
- L9: panel hides controls on an owner's keys, grants and tokens from administrators and no longer offers owners or
  their keys in the add-key and new-grant pickers (`ui-owner-assets.test.ts`).
- Q6-Q8, Q10: docs and `env.ts` as listed (`projects-{light,dark}.png` are now referenced from the admin panel guide;
  the component file was not renamed).
- Q9: login-transaction cookie named twice is no cookie (test in `identity.test.ts`).

Dropped, with reasons:
- **Sharing the `signin:` prefix through the Workers binding.** The binding has one fixed rule (600 per 60 s per
  location, `wrangler.jsonc`); the sign-in rule is 60 per 5 min per IP. Adding the prefix would count sign-ins in that
  600 and only trip far above the intended limit, so it would look like a shared limit while not being one. The real fix
  is the Durable Object limiter (P7-10); the docs already say the sign-in limit is per isolate on Workers.
- **`audit.export` row per CSV export.** The CSV is built by the panel through in-process admin API calls, each already
  charged to the per-IP limit; a row needs an audit hook in the panel kit (it has none) or a new API route. Logged in
  `docs/pending-decisions/phase-4.md` for the owner (reads are not audited anywhere today, I2).

## Security notes
T13 (CSP, CSRF coverage), T20 (sign-in limit on Workers). No new attack surface.

## Docs to update
- The files named above.

## Out of scope
- Real-IdP end-to-end validation (pending decision P4-01, P4-08).
