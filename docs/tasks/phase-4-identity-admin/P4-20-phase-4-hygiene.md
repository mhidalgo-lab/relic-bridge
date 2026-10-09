---
id: P4-20
title: "Phase 4 test, docs and UI hygiene from the consolidation review"
phase: 4
status: todo
priority: low
depends_on: [P4-08]
adr: []
owner: ""
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
- [ ] Each bullet above done or explicitly dropped with a reason in this file.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers` green.

## Security notes
T13 (CSP, CSRF coverage), T20 (sign-in limit on Workers). No new attack surface.

## Docs to update
- The files named above.

## Out of scope
- Real-IdP end-to-end validation (pending decision P4-01, P4-08).
