---
id: P3-11
title: Master-key rotation for a D1 database
phase: 3
status: in-progress
priority: medium
depends_on: [P3-02, P3-05]
adr: [0007]
owner: claude-agent
---

# P3-11 — Master-key rotation for a D1 database

## Goal
Let a Workers deployment rotate `RB_MASTER_KEY` without re-entering every New Relic key. Today `relic-bridge keys
rotate` opens a local SQLite file (`--db`); a Worker's D1 database is not reachable from it, so after setting
`RB_MASTER_KEY_PREVIOUS` the stored credentials stay under the old key version until each is replaced with
`credential rotate`.

## Design
An authenticated admin API operation, `POST /api/admin/v1/keys/rotate`, executed by the server that holds both keys
(the Worker, or `relic-bridge serve`), re-encrypting **one bounded batch** per call; `relic-bridge keys rotate --remote
<url>` calls it in a loop until every row was visited. Chosen over a cron-driven background rotation: the operator
needs a clear "done, you may remove the previous key" answer and a report of rows that could not be rotated, a cron
run reports nothing to anyone and would rotate on a schedule the operator does not control. The cron trigger stays
for the audit purge only.

## Scope
- `@relic-bridge/auth`: `rotateCredentialKeysBatch(storage, keyring, { after, limit })`: the per-row logic of
  `rotateCredentialKeys` (decrypt, re-encrypt, compare-and-swap `CredentialPatch.ifKey`, read-back) over the rows with
  an id after the cursor, at most `limit` re-encryptions per call; key check values verified first (P2-03 SR-1/SR-2
  checks unchanged). `rotateCredentialKeys` keeps its behaviour and shares the per-row code.
- Admin API: `POST /keys/rotate`, body `{ "batchSize"?: 1-100 (default 25), "after"?: <cursor> }`. Answer: current
  version, counts, re-encrypted ids, failed `{id, code}`, `nextCursor` (`null` when every row was visited),
  `pending` (rows not on the current version), `versionsInUse`. Never any key material. One `audit.admin` row per
  call (`keys.rotate`, target `master_key`), including refused requests. Admin storage gains `settings`.
- Bounded per call for Worker limits: D1 queries ≈ batch size + 5 (Free plan: 50 per invocation), CPU a few AES-GCM
  operations per row.
- CLI: `relic-bridge keys rotate --remote <url> [--insecure] [--batch-size <n>] [--json]` (admin token from
  `RB_ADMIN_TOKEN` / `_FILE` / prompt, like the management commands); loops until `nextCursor` is `null`, waits on
  `429 Retry-After`, prints a summary; exit 0 only when every row is on the current version. Without `--remote` the
  local SQLite path is unchanged.
- Authorization matrix (P2-12) entry for the new route.
- Docs: Worker rotation runbook in `docs/guide/secrets.md` and `docs/guide/cloudflare-deploy.md` (replacing the
  interim `credential rotate` procedure), CLI reference, generated admin API reference, THREAT_MODEL.

## Acceptance criteria
- [ ] A rotation on D1 (Workers runtime test, local D1) leaves every row readable after each batch, resumes after an
      interruption (a later call or a fresh run from the start finishes the job), and a second run changes nothing.
- [ ] Tests: wrong current key or wrong previous key → `503 unavailable` with the crypto code and no row changed;
      retired key (SR-1) refused; concurrent credential change → reported `conflict`, never overwritten; missing
      previous key → rows reported `key_version_unknown`, not dropped.
- [ ] Authorization: no / wrong / MCP token → 401 and no change (P2-12 matrix entry; guard test passes).
- [ ] Every call writes an `admin` / `keys.rotate` audit row; neither the answer nor the audit row contains key
      material (ciphertext, IVs, master or New Relic keys).
- [ ] CLI `keys rotate --remote` loops to completion, handles `429`, reports failures, exit codes 0 / 1 / 2; tests.
- [ ] Runbook documented for Workers and for `serve` (`--remote` works against both).

## Security notes
T7, T8. The operation must never return key material and must be admin-only. A rotation only re-encrypts what is
stored; the old key may only be removed once a run reports nothing pending (isolates still running the old
deployment could write under the old version until they drain, so the runbook re-runs the rotation before removing
the previous key).

## Docs to update
- `docs/guide/secrets.md`, `docs/guide/cloudflare-deploy.md`, `docs/reference/admin-api.md` (generated),
  `docs/reference/cli.md`, THREAT_MODEL.

## Out of scope
- Rotating the New Relic keys themselves.
- Rotation driven by the cron trigger (see Design).
