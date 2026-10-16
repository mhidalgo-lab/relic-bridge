---
id: P8-94
title: cf:setup --name writes the Worker name, migration next steps, and guide fixes
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: "claude-agent"
---

# P8-94 — cf:setup --name writes the Worker name, migration next steps, and guide fixes

## Goal
A second Cloudflare deploy report (v0.11.0, migration from a self-hosted server) found:
- **N1 (high):** `cf:setup --name <name>` creates `wrangler.<name>.local.jsonc` with its own D1 database but keeps
  `"name": "relic-bridge"`. Plain `wrangler … -c wrangler.<name>.local.jsonc` commands (which the guide's "Rotate the
  master key" section tells `--name` users to run) then act on the **production** Worker: secrets written or deleted
  there, or a staging config deployed over it.
- **N2:** after `--master-key-stdin`, the next steps still say `credential add`, `project add`, and so on, which create
  duplicates after an import.
- **N3:** `--dry-run --master-key-stdin` lists `RB_MASTER_KEY` among the generated secrets.
- **N4:** the guide's HSTS note says `includeSubDomains` on a custom domain covers the zone's subdomains. It covers only
  subdomains of the host that sent it (RFC 6797 §8.2).
- **N5:** no Docker form of the export step, and no note on copying the file out of the volume with its mode kept.

## Scope
- Write `"name": "<name>"` into the copy when creating it. On re-runs, refuse (with the fix to apply) when the copy's
  `name` differs from `--name`. For copies made by older versions with the default name, rewrite the name once and say
  so.
- Guide: every `-c wrangler.<name>.local.jsonc` example is correct on its own (the copy names the Worker), and a check
  command (`wrangler deployments list -c …`) is shown before secret changes.
- Next steps with `--master-key-stdin`: point to the import and check steps of "Migrate from a self-hosted server".
- Dry run: don't list `RB_MASTER_KEY` as generated when it comes from stdin.
- Guide fixes for N4 and N5 (`docker exec <container> relic-bridge db export … --format d1`, copy with `scp -p` or
  `install -m 600`).

## Acceptance criteria
- [x] Script tests: new copy has the right name; a mismatched name refuses; an old default-named copy is rewritten once.
- [x] Script tests for the migration next steps and the dry-run secret list.
- [x] Guide updated; `pnpm lint` passes.

## Security notes
T15-style operator mistakes: the bug can push secrets to, or delete them from, the wrong Worker. Note this in
THREAT_MODEL (deployment section) if there's a matching threat.

## Docs to update
- `docs/guide/cloudflare-deploy.md`, changeset (patch, private scripts if applicable).

## Out of scope
- Cleaning up Workers or databases on Cloudflare.
