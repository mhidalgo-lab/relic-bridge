# 0004 — TypeScript monorepo, runtime-agnostic core, Hono

- Status: accepted
- Date: 2026-10-01

## Context
It must run locally without a Cloudflare account **and** as a Cloudflare Worker, with no runtime choice blocking later features.

## Decision
- **TypeScript** (strict), **pnpm workspaces**, Node **active LTS** for tooling and the CLI.
- `packages/core`, `packages/auth`, `packages/http-app` use **web-standard APIs only** (`fetch`, `Request`/`Response`,
  WebCrypto, streams). A lint rule forbids `node:*` imports and Node globals in these packages.
- HTTP framework: **Hono**. It runs on Workers natively and on Node through `@hono/node-server` (also Bun/Deno).
- Runtime-specific code is limited to `packages/storage` adapters, `apps/cli`, `apps/worker`.
- Tooling: Biome (lint + format), Vitest (+ `@cloudflare/vitest-pool-workers`), tsdown/tsup for builds, Changesets
  for versioning. Final picks are confirmed in P0-01.
- Admin UI: **server-rendered Hono JSX** with a small amount of static, CSP-compatible JS. No SPA framework, which
  means a smaller supply chain, the same code on both runtimes, and an easy strict CSP. If interactivity needs grow,
  reconsider (new ADR).

## Consequences
- One codebase for every mode. Some Node-only libraries (e.g. `oidc-provider`) can only live in adapters.
