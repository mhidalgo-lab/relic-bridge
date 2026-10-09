---
id: P7-30
title: "Low-severity follow-ups from the Phase 7 review"
phase: 7
status: todo
priority: low
depends_on: [P7-23]
adr: []
owner: claude-agent
---

# P7-30 — Low-severity follow-ups from the Phase 7 review

## Goal
Small items from `docs/reviews/phase-7-review.md` (L1 … L9) that were not fixed in place.

## Scope
- **Keychain (L1):** `apps/cli/src/keychain.ts` spawns `powershell.exe` by bare name (Windows searches the current
  directory first) and `security` by name on macOS. Use `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  and `/usr/bin/security`.
- **OTLP log `path` (L2):** `packages/http-app/src/telemetry.ts` `LOG_FIELDS.path` allows lowercase filesystem paths
  (`serve.ts` logs `{ path: dbPath }`), sending a username and layout to the collector. Export HTTP route paths only.
- **Cache hits and quotas (L3):** a query-cache hit is not counted by the quota guard, so a grant at its hard cap is
  still served cached rows (30 s relative, 10 min settled). Document in T16/T5, or check "cap reached" before lookup.
- **Quota soft spots (L4):** counter-store errors allow the call (fail open, intended) and the inspected-events cap is
  known only after a call (parallel calls overshoot). Say both in `docs/guide/quotas.md`.
- **`list_alert_conditions` (L5):** rows with no `entityGuid` pass the account re-check (`alerts.ts`); drop rows with
  no account claim if NerdGraph does not bind cursors to a query.
- **Unused cursor helpers (L6):** `packages/core/src/output/compact.ts` `encodeCursor`/`decodeCursor` are unbound
  offset cursors with no caller; delete them so nobody wires them in.
- **Setup mode (L7):** a whitespace-only `NEW_RELIC_API_KEY` lands in stdio setup mode instead of a configuration
  error.
- **Slow authz test (L8):** `packages/http-app/test/authz/tools.test.ts` "ungranted tools" iterates the whole catalog
  (about 18 s); give it an explicit timeout or split it.
- **Release hygiene (L9):** only one changeset exists for Phase 7; add changesets for write tools, Tasks, doctor,
  config import/export, keychain, quotas, OTLP and the plugin. `docs/ROADMAP.md` and `README.md` still describe
  Phase 6 as current. Remove the unused `checkPeriods` import in `apps/worker/src/shared-limiter.ts`.

## Acceptance criteria
- [ ] Each item fixed with a test where behaviour changes, or recorded as accepted in the THREAT_MODEL.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/guide/quotas.md`, `docs/ROADMAP.md`, `README.md`.
