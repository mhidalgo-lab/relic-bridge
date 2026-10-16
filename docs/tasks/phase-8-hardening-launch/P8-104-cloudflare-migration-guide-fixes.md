---
id: P8-104
title: Cloudflare migration - Docker export command, Worker name check, re-run next steps
phase: 8
status: todo
priority: medium
depends_on: []
adr: []
owner: ""
---

# P8-104 — Cloudflare migration: Docker export command, Worker name check, re-run next steps

## Goal
Third Cloudflare deploy report (v0.12.0 retest of the self-hosted-to-Worker migration):
- **R1 (medium):** the guide's `docker exec <container> relic-bridge db export …` fails: the image is distroless with
  `ENTRYPOINT ["/nodejs/bin/node", "/app/dist/index.mjs"]` and has no `relic-bridge` on the `PATH`.
  `docker exec <container> /nodejs/bin/node /app/dist/index.mjs db export …` works.
- **R2 (low):** the guide says `wrangler deployments list -c wrangler.<name>.local.jsonc` "shows the Worker name"; with
  Wrangler 4.149 it doesn't.
- **R3 (low):** a `cf:setup` re-run between setup and import (the custom-domain path) has no `--master-key-stdin`, so
  it prints `credential add` / `project add` again; following them makes the database non-empty and the import guard
  then refuses the export.

## Scope
- R1: use the working `docker exec … /nodejs/bin/node /app/dist/index.mjs db export …` form. Check the Dockerfile and
  any other doc that uses `docker exec <container> relic-bridge …`, and fix them the same way. Don't document
  `docker run` against a live database.
- R2: replace the check with one that shows the name (read `"name"` from the copy), and note that `cf:setup --name
  <name>` rewrites or refuses a wrong name.
- R3: base the next steps on the D1 contents: when the database has no users/projects, print both branches
  ("migrating? import now" and "new? credential add"); otherwise the usual steps. If querying D1 fails, print both.

## Acceptance criteria
- [ ] Script tests for the next steps on an empty and a non-empty database, and when the check fails.
- [ ] Guide and any Docker docs updated; `pnpm lint` passes.

## Security notes
The D1 check is read-only and runs with the operator's Wrangler login.

## Docs to update
- `docs/guide/cloudflare-deploy.md`, Docker docs if affected, changeset (patch, private scripts if applicable).

## Out of scope
- Adding a `relic-bridge` shim to the image.
