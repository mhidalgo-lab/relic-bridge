---
id: P0-01
title: Bootstrap the monorepo
phase: 0
status: review
priority: high
depends_on: []
adr: [0004]
owner: ""
---

# P0-01 — Bootstrap the monorepo

## Goal
A clean, reproducible TypeScript monorepo that every later task builds on.

## Scope
- `git init`, default branch `main`, `.gitignore`, `.editorconfig`, `.nvmrc` / `engines` (Node active LTS), `packageManager` (pnpm, pinned).
- pnpm workspace with empty packages: `packages/{core,storage,auth,http-app,admin-ui}`, `apps/{cli,worker}`.
- Shared `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ES2023, `moduleResolution: bundler`).
- Biome config (lint + format). Lint rule or custom check: **no `node:*` imports** in `core`, `auth`, `http-app`.
- Vitest workspace config; one smoke test per package.
- Build tool for libraries (tsdown or tsup — pick and record in ADR-0004 if it differs).
- Changesets initialised.
- Check npm name availability for `relic-bridge` (and the `@relic-bridge` scope); reserve them.

## Acceptance criteria
- [x] `pnpm i && pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass from a clean clone.
- [x] Importing `node:fs` inside `packages/core` fails lint.
- [x] npm name decision recorded in ADR-0002.

## Security notes
T18: lockfile committed; `pnpm` set to `strict-peer-dependencies` and `only-built-dependencies` allowlist (no arbitrary install scripts).

## Docs to update
- `README.md` (dev setup section), `CONTRIBUTING.md`.

## Out of scope
- CI (P0-03), security tooling (P0-04).

## Progress notes
- 2026-10-01: pnpm 12 workspace, TS 7.0.2 (strict + isolatedDeclarations), Biome 2.5, Vitest 4.1 (kept on 4.x for
  `@cloudflare/vitest-pool-workers` compatibility), tsdown 0.23, Changesets, lefthook. Runtime guard: `scripts/check-runtime-imports.ts`
  (packages with `"relicBridge": {"runtime": "web"}`), run by `pnpm lint`.
- Supply chain: `minimumReleaseAge` 3 days, `trustPolicy: no-downgrade`, `blockExoticSubdeps`, `strictDepBuilds` + `allowBuilds`.
- 2026-10-02: clean clone (`pnpm install --frozen-lockfile`) passes lint, typecheck, test, build and the license check.
  **Pending (maintainer):** `npm login`, create the `relic-bridge` npm org, and publish the 0.0.0 placeholder to secure the name.
