---
id: P8-116
title: Cloudflare migration - remove the export from a Docker volume, never copy a stale one
phase: 8
status: in-progress
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-116 — Cloudflare migration: remove the export from a Docker volume, never copy a stale one

## Goal
Fourth Cloudflare migration retest (v0.13.1, 2026-10-23), step 4 of "Migrate from a self-hosted server" with Docker:
- The guide says "Delete the copy in the volume once the import succeeded" but gives no command. The image is
  distroless (no shell, no `rm`) and the volume belongs to the image user, so the host user often cannot delete it
  either. An export from the v0.11.0 test (2026-10-15) was still in the volume a week later: encrypted New Relic keys
  and token hashes left next to the live database.
- Because that file existed, the next `db export` refused ("export destination already exists … use --force"), and the
  guide's next line (`docker cp … && chmod 600 …`) copied the **old** file with no error. Only reading the export's
  output showed it; the import would have brought a week-old database.

## Scope
- Guide (`docs/guide/cloudflare-deploy.md`, step 4): chain the Docker commands so a refused export stops before the
  copy (`docker exec … db export … && docker cp …`), and give the delete command that works in the image, for example
  `docker exec <container> /nodejs/bin/node -e "require('fs').unlinkSync('/data/relic-bridge-d1.sql')"`. Say to delete
  it right after the copy (the local copy is the one imported), not only after the import.
- `db export`: when the destination exists, the refusal names the existing file's modification time, so a stale export
  is obvious; the closing hint after a successful export ends with how to delete the file (for a path under `/data`,
  the `docker exec … node -e` form as well as `rm`).
- Check other docs that show `db export` (Docker guide, CLI reference) for the same gap.

## Acceptance criteria
- [ ] CLI test: the refusal for an existing destination includes its modification time; the success hint says how to
      delete the file.
- [ ] Guide step 4 chains export and copy and shows the delete command; `pnpm lint` passes.

## Security notes
The export holds encrypted New Relic keys and token hashes (T34): leaving it in the volume widens what a copy of the
data directory exposes. No change to what the export contains or its mode (0600).

## Docs to update
- `docs/guide/cloudflare-deploy.md`, any other page showing `db export`, `docs/THREAT_MODEL.md` T34 if the wording
  about the export file changes, changeset (patch) for the CLI message.

## Out of scope
- Streaming the export to stdout, or a `relic-bridge` shim in the image.
