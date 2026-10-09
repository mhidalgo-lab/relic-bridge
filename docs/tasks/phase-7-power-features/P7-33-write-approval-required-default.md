---
id: P7-33
title: Default RB_WRITE_APPROVAL to required
phase: 7
status: review
priority: high
depends_on: [P7-25]
adr: ["0015", "0016"]
owner: claude-agent
---

# P7-33 — Default RB_WRITE_APPROVAL to required

## Goal
Implement ADR-0016 (owner decision 2026-10-09): when write tools are on, a write needs a human approval by default;
`client` becomes an explicit opt-down.

## Scope
- Default `required` in `apps/cli/src/args.ts` / `apps/cli/src/stdio.ts`, `apps/cli/src/serve.ts`,
  `apps/worker/src/settings.ts` (and anywhere else the default is resolved).
- Startup warning when writes are on and `RB_WRITE_APPROVAL=client` (keep/adjust the existing one).
- Write docs and examples: say that clients without elicitation can only dry-run until `client` is set.

## Acceptance criteria
- [x] Unset `RB_WRITE_APPROVAL` behaves as `required` on all three runtimes; tests cover unset, `client`, `required`.
- [x] Negative test: a non-elicitation connection with writes on and the variable unset gets `applied: false`, no
      mutation, audit `confirmation: unavailable`.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass; generated docs regenerated.

## Security notes
T6, T31: removes the model-only approval path by default. Update `docs/THREAT_MODEL.md` T31.

## Docs to update
- Write-tools guide, configuration reference, `docs/guide/cloudflare-deploy.md` vars, THREAT_MODEL T31.

## Out of scope
- Per-project or per-grant approval flags (decided against, P7-25).
