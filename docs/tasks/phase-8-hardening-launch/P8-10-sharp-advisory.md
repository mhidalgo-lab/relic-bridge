---
id: P8-10
title: Clear the failing dependency audit (sharp and two other dev-only advisories)
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-10 — Clear the failing dependency audit (sharp and two other dev-only advisories)

## Goal
The `Dependency audit` job (`pnpm audit --audit-level high`, `.github/workflows/security.yml`) fails. The advisory this
task was opened for is GHSA-wq5f-xc86-pv6w (`sharp` < 0.35.5, librsvg), reached through `wrangler` / `miniflare` (dev
dependency of `apps/worker`). The same audit run reports two more dev-only advisories that keep the job red
(`shell-quote` GHSA-pqg4-j6r4-53mv via `@changesets/cli`, `source-map-js` GHSA-68fv-2mgg-jv7q via vite/jsdom/postcss), so
all three are cleared here; otherwise the job would stay failing.

## Scope
- Resolve `sharp` by upgrading `wrangler` and `@cloudflare/vitest-plugin` (miniflare pulls `sharp`). Preferred over
  an override. If the newest miniflare still pins a vulnerable `sharp`, use a `pnpm-workspace.yaml` override to
  `>=0.35.5` (same mechanism as the existing `@esbuild-kit/core-utils>esbuild` override, with a comment naming the
  advisory).
- Resolve `shell-quote` (>= 1.11.0) and `source-map-js` (>= 1.2.2) with a lockfile refresh or `pnpm-workspace.yaml`
  overrides, whichever is the smaller change.
- The repo has no audit-ignore mechanism (`pnpm audit` is run bare; no `ignoreGhsas` or ignore list). Patched versions
  exist for all three, so no audit exception is added. If a fix ever proves unavailable, the fallback is a
  documented, time-boxed `auditConfig.ignoreGhsas` entry in `pnpm-workspace.yaml` with an expiry date and a comment.
- Check whether `sharp` is reachable at runtime in the shipped artifacts and record the finding (below and in
  `docs/RESEARCH.md`).
- Update any pinned-wrangler notes in docs; run the Workers tests.

## Runtime reachability (verified)
`sharp` is an optional dependency of `miniflare` (local Images binding simulation). `miniflare`, `wrangler` and
`@cloudflare/vitest-plugin` are devDependencies of `apps/worker` only. The Worker bundle (`wrangler deploy`) contains
none of them, the CLI bundle and the Docker image install `relic-bridge` production dependencies only (no worker
workspace), so `sharp` is absent from all three shipped artifacts. Verified: `pnpm --filter relic-bridge --prod deploy` has no `sharp`; `wrangler deploy --dry-run` output and the CLI bundle contain neither `sharp` nor `miniflare`.

## Outcome
No released miniflare (and so no wrangler) past the 3-day `minimumReleaseAge` pins `sharp` >= 0.35.5 (wrangler 4.149.0 would be the first to pull it but is too new to install), so the three advisories are cleared with pnpm overrides in `pnpm-workspace.yaml` (`sharp` 0.35.5, `shell-quote` 1.11.0, `source-map-js` 1.2.2). wrangler stays at 4.144.0. Remove the `sharp` override once a released miniflare pins >= 0.35.5.

## Acceptance criteria
- [x] `pnpm audit --audit-level high` reports no vulnerabilities.
- [x] `sharp` resolves to >= 0.35.5 in `pnpm-lock.yaml`.
- [x] Reachability in the CLI bundle, Worker bundle and Docker image production install is verified and documented.
- [x] `pnpm lint && pnpm typecheck && pnpm test` and `pnpm test:workers` pass; `wrangler deploy --dry-run` still builds.
- [x] Docs updated (wrangler is unchanged at 4.144.0, so only the advisory note was added to `docs/RESEARCH.md`).

## Security notes
THREAT_MODEL T18 (supply chain). Dev-tooling advisories only; no change to runtime trust boundaries.

## Docs to update
- `docs/RESEARCH.md` (wrangler version, sharp reachability note).
- `docs/THREAT_MODEL.md` only if the conclusion about reachability changes the T18 analysis.

## Out of scope
- A general audit-exception framework; a scheduled audit-fix bot (Renovate already tracks versions).
