---
id: P8-83
title: Cloudflare guide clarity - CLI build step, zone security note, no internal ids, section order
phase: 8
status: done
priority: low
depends_on: [P8-82]
adr: []
owner: claude-agent
---

# P8-83 — Cloudflare guide clarity: CLI build step, zone security note, no internal ids, section order

## Goal
Documentation findings from a deploy report that followed `docs/guide/cloudflare-deploy.md` (Path A) with a custom
domain. Readers hit things the guide does not say, or references they cannot look up.

1. **CLI build.** The bash instructions call `relic-bridge ...`, but a fresh clone has no built CLI
   (`pnpm install` does not build `apps/cli`); only the PowerShell block mentions `node apps/cli/dist/index.mjs`.
2. **Zone security.** On a custom domain, a non-browser MCP client got Cloudflare error 1010 (Browser Integrity Check)
   before the request reached the Worker. Browser Integrity Check, Bot Fight Mode and the security level can block MCP
   clients; the guide does not mention them or how to exempt the MCP routes.
3. **Internal ids.** The guide and the `wrangler.jsonc` comments refer to task ids (`P3-01`, `P5-03`, `P5-13`, `P7-10`,
   ...), `ADR-0011`, threat `T7` and "the pending decisions", which readers cannot look up.
4. **Order.** "Updating" refers to `cf:setup --sign-in` before "Sign-in on the Worker" introduces it, and Path B (Deploy
   button, never exercised against this repository) is listed as a peer of Path A.

## Scope
- `docs/guide/cloudflare-deploy.md`:
  - bash instructions: the CLI build step and the `node apps/cli/dist/index.mjs` form (as in PowerShell);
  - "Custom domain": a zone security note (error 1010; Browser Integrity Check, Bot Fight Mode, security level; a WAF
    custom rule with the Skip action for `/p/*/mcp` and `/passthrough/mcp`, with the current dashboard path and
    expression, checked in Cloudflare's docs; what a skip rule turns off; Bot Fight Mode cannot be skipped);
  - internal ids removed or replaced by links to published pages (ADRs, threat model) or plain words;
  - `--sign-in` introduced before "Updating" uses it (a short pointer in Path A's options);
  - Path B moved below Path A's follow-up sections, under a "not yet verified" heading.
- `apps/worker/wrangler.jsonc` comments: no task ids; ADR references written so a reader can find them (`docs/adr/...`).
- User-facing strings of `scripts/cloudflare-setup.ts` (help text and notes) without task ids.
- `docs/RESEARCH.md`: the zone security facts with sources.

## Acceptance criteria
- [x] The bash "Connect your devices" block builds the CLI (or says how) and shows the `node apps/cli/dist/index.mjs`
      form.
- [x] "Custom domain" explains error 1010, the three zone settings, and a skip rule for the MCP paths, with the dashboard
      path and rule expression from current Cloudflare docs, what it turns off, and that Bot Fight Mode cannot be skipped.
- [x] No `P<n>-<nn>`, `ADR-<nnnn>`, `T<n>` or "pending decisions" in the guide, the `wrangler.jsonc` comments or the
      setup script's help and notes.
- [x] `--sign-in` is introduced before "Updating"; Path B sits under a "not yet verified" heading after Path A.
- [x] `pnpm docs:check` passes.
- [ ] The skip rule verified on a real zone with an MCP client that got 1010 (unticked: needs the owner's zone).

## Security notes
Documentation only. The skip rule weakens zone protections for the MCP paths: the guide must say so, keep it narrow
(those paths, the custom hostname, only the products that block MCP clients), and note that the Worker's own token
check and rate limits still apply. No code path changes; no THREAT_MODEL change.

## Docs to update
- `docs/guide/cloudflare-deploy.md`, `apps/worker/wrangler.jsonc`, `docs/RESEARCH.md`.

## Out of scope
- Migration from a self-hosted server (P8-80); script behaviour (P8-81, P8-82); internal ids in other guides.
