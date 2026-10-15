---
id: P8-81
title: Record the D1 database id in the local Wrangler config and stop the "remote configuration differs" noise
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-81 — Record the D1 database id in the local Wrangler config

## Goal
A deploy report from following the Cloudflare guide (Path A) found that `pnpm cf:setup` never stores the D1
`database_id` in `apps/worker/wrangler.local.jsonc`, although the guide says Wrangler "records their ids in the copy".
Every later `wrangler deploy` then prints a "remote configuration differs" diff (`- database_id` / `+ database_name`)
and "Uploading the Worker will override the remote configuration with your local one". The deploy is correct, but the
warning appears on every update and hides a real difference among the noise. Two guide statements also rest on the id
being stored ("Deleting it would make Wrangler provision a new D1 database"; "resources stay linked by name").

Establish the real Wrangler 4.144.0 behaviour, record it with sources, make `cf:setup` write the id, and align the
guide.

## Scope
- Research (Wrangler 4.144.0 source and current Cloudflare docs): when automatic provisioning writes ids back, how a
  binding by `database_name` resolves on the first and later deploys, what two databases of the same name mean, why the
  diff appears and which diffs Wrangler treats as harmless. Record it in `docs/RESEARCH.md` and correct the older
  research notes that say ids are always written back.
- `scripts/cloudflare-setup.ts`: after a successful deploy, when the local copy's D1 binding has no `database_id`, look
  the database up (`wrangler d1 list --json`, by exact name) and insert its `database_id` into the copy in place
  (comments and the user's edits kept). Never touch a binding that already has an id. A failed or ambiguous lookup is a
  warning, not a failed setup. `--dry-run` lists the step.
- `docs/guide/cloudflare-deploy.md` (step 2 of Path A, Updating, Troubleshooting) and the `wrangler.jsonc` header
  comment: say what really happens.

## Acceptance criteria
- [x] `docs/RESEARCH.md` explains, with sources: write-back only in an interactive terminal; later deploys inherit the
      Worker's current D1 binding when its name matches; a first deploy adopts an existing database of that name; the
      diff and when it blocks; why an id in the config makes it go away.
- [x] `cf:setup` writes `database_id` into `wrangler.local.jsonc` (or `wrangler.<name>.local.jsonc`) after the deploy,
      once, keeping the rest of the file byte for byte; a copy that already has an id is left alone.
- [x] A failed `d1 list`, invalid JSON, no match or a non-UUID id produce a warning and leave the file unchanged; the
      setup still succeeds.
- [x] `--dry-run` describes the step and calls nothing.
- [x] Tests: insertion (default and `--name` copies, comments kept, existing id untouched), each failure path, call order
      (lookup after deploy), dry run. No network.
- [x] The guide no longer claims that deleting the copy provisions a new database, and explains the diff message.
- [ ] Quiet second deploy confirmed against a real account (unticked: needs the owner's deployment).

## Security notes
None. The database id is not a secret (it is an account resource identifier); it goes into the git-ignored copy only,
never into the committed `wrangler.jsonc`, and is not printed. No secret handling changes.

## Docs to update
- `docs/RESEARCH.md`, `docs/guide/cloudflare-deploy.md`, `apps/worker/wrangler.jsonc` (comment), `scripts/cloudflare-setup.ts`
  header comment.

## Out of scope
- Migration from a self-hosted server (P8-80); printing the real URL, the drift warning, the login check and the CLI
  build (P8-82); other guide clarity fixes (P8-83).
