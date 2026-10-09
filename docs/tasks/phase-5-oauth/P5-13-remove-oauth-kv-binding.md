---
id: P5-13
title: Remove the unused OAUTH_KV Worker binding
phase: 5
status: in-progress
priority: low
depends_on: [P5-01]
adr: ["0011"]
owner: claude-agent
---

# P5-13 — Remove the unused OAUTH_KV Worker binding

## Goal
Owner decision (pending-decisions phase 5, P5-01, 2026-10-09): OAuth provider state lives in the storage `kv` table
(ADR-0011), so the declared `OAUTH_KV` KV namespace is dead weight that every deploy creates. Remove it.

## Scope
- `apps/worker/wrangler.jsonc`: drop `kv_namespaces`; `apps/worker/src/env.ts`: drop `OAUTH_KV` from `WorkerEnv`;
  `apps/worker/test/entry.test.ts`: drop the binding assertion.
- `scripts/cloudflare-setup.ts`: stop creating/normalising the namespace; existing local copies with the binding
  keep working (a leftover binding is harmless) and `cf:setup` warns that it can be removed.
- Keep the internal provider adapter (`oauthKvNamespace`, `OAUTH_KV_PREFIX`): it is what the provider library sees as
  `env.OAUTH_KV`, not a Cloudflare binding.

## Acceptance criteria
- [ ] No Worker binding named `OAUTH_KV`; Workers runtime tests and `cf:setup` tests pass.
- [ ] Deploy docs no longer mention a KV namespace; upgrade note says how to delete the old namespace
      (`wrangler kv namespace delete`).

## Security notes
Reduces surface (one fewer binding); no behaviour change.

## Docs to update
- `docs/guide/cloudflare-deploy.md`, `apps/worker/README.md`, ADR-0011 (append an "Update (P5-13)" line).

## Out of scope
- `spikes/oauth/` (historical).
