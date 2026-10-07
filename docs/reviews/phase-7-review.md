# Phase 7 consolidation review

- **Scope:** all of Phase 7 (power features):
  `git diff task/P6-24-consistent-paging...task/P7-23-tasks-remaining-reports` (P7-01 … P7-23 without the blocked
  P7-15; 60 commits, 264 files, about 29.5k lines added). New: result shaping v2, query cache, UI links, MCP Apps charts,
  doctor, config import/export, Claude Code plugin, OTLP self-monitoring, four opt-in write tools with elicitation,
  Durable Object limiter, OS keychain, grant quotas, MCP Tasks (four composite reports and `run_nrql`), public tool
  catalog and stdio setup mode.
- **Branch:** `review/phase-7`, stacked on `task/P7-23-tasks-remaining-reports` (top of the Phase 7 PR stack).
- **Date:** 2026-10-07.
- **Method:**
  - Read the task files, ADR-0014, ADR-0015 and its addenda, THREAT_MODEL T5, T16, T22 and T27 to T33, and
    `docs/pending-decisions/phase-7.md` first.
  - Checked the eight concerns the owner named (below) myself or through four parallel read-only sub-reviews, each
    cross-checked against the code: (1) paging cursors, query cache and the public catalog; (2) write tools end to end
    and MCP Tasks; (3) removed or weakened tests, MCP Apps, OTel, keychain, doctor, DO limiter, quotas and the AGENTS.md
    hard rules; (4) completeness against every acceptance criterion and the roadmap.
  - Wrote probe tests for the suspected bypasses. The confirmed ones are now regression tests, and each fails with its
    fix reverted: H1 has 3 tests, all 3 fail; H2 has 3 tests, all 3 fail; L-doc has 1 test, which fails.
  - Nothing was deployed, published or tagged. No New Relic, LLM or OTLP endpoint was called and no real mutation ran.
    GitHub Actions is unavailable (billing), so every check was run locally (see [Local CI](#local-ci)).

## Verdict

**Ready to merge as a stack, with the fixes on this branch.** There are no critical findings and two high findings,
both fixed here:

- **H1:** a config import could share a colleague's stored personal New Relic key with a new project. That undid the
  Phase 4 owner boundary (P4-18).
- **H2:** a write approval was shown shortened, and it was bound only to the shortened text.

A small hardening of the ADR-0014 mutation guard is also fixed. The mediums and lows are tracked in P7-24 … P7-30.

What holds:

- **Write tools are gated at every layer:**
  - the server flag;
  - explicit names on both project and grant, never "all tools";
  - owner-only in every admin path;
  - a shared or own key only;
  - OAuth `mcp:write` with a separate consent that is never silent;
  - never on pass-through;
  - `confirm: true` or `dry_run`, with elicitation added on top;
  - a failing-closed rate-limit hook and an audit row.
- **Read paths:**
  - Tasks are bound to their principal.
  - The query cache is isolated per grant, credential and key.
  - Cursors cannot cross an account, tool or limit.
  - The public catalog is no oracle.
- **No test regressions:** no authorization test was dropped across Phase 7. The P7-21 report-task cases removed by
  P7-22 are back in P7-23, extended to all four composites.

**The roadmap promise is met in code and in mocked tests.** The promise covers charts, cache, deep links, doctor,
import/export, plugin, self-monitoring, write tools, the DO limiter, keychain, quotas and Tasks. Nothing ran against a
real client or account, though. Eight acceptance criteria are honestly left unticked and logged:

- Apps rendering;
- Tasks and elicitation in a real client;
- the DO limiter under load;
- the UI link formats;
- the plugin and registry publish;
- a live Node-to-Worker move.

The NerdGraph mutation shapes are unverified too. **A live pass on a test account is the main open risk before v0.7+.**

## Owner's concerns

1. **P7-06 personal key as project default: a real bypass, fixed (H1).**
   - The import matched bundle credentials to stored ones by owner email and label (visible metadata), then set a
     project's default to the match with only a warning.
   - An owner, or the admin token, could import `{credentials: [{owner: colleague, label: their-key}], projects:
     [{defaultCredential: it}], grants: [{user: me, credential: null}]}`. They would then query New Relic through a
     colleague's key, which `POST /projects` refuses (`guardProjectDefault`).
   - Fixed: see H1.
2. **P6-24 unsigned cursors: no finding.**
   - The cursor is `base64url(JSON)` with a binding, a SHA-256 over tool, account and filters
     (`packages/core/src/tools/paging.ts:30-35`).
   - Account, guid, filters and NRQL always come from the call's own arguments, which are authorized as usual. A cursor
     only carries offsets, an upstream cursor (`^[A-Za-z0-9+/=_.:-]{1,2048}$`, sent only as a GraphQL variable) and
     window bounds.
   - Window bounds are re-checked with `assertWindowWithinLimit` at every time-paged call site.
   - `limit` comes from the input schema and offsets are capped. A forged cursor can shift a window into the past,
     which is no wider than an absolute `time_range`.
   - Probe-checked: a cursor minted for account 1 is refused on account 2, and a forged 10-day window under a 1-day
     limit is refused before any request.
3. **Removed authz/security tests: none besides the known one.**
   - No test file was deleted or renamed.
   - No `.skip`, `.todo` or `xit` was added, and no assertion was loosened.
   - P7-22 replaced "pass-through offers no tasks" with a stricter fingerprint-scoped suite.
   - P7-23 restored the P7-21 report-task cases ("visible to creator only", "grant lost the tool") over all four
     composites.
   - The `TOOL_CASES == CATALOG` guard (`packages/http-app/test/authz/tools.test.ts`) is intact.
4. **Write tools: gated end to end, with two findings.** H2 is fixed. M1, M2, M3 and M5 are tracked.
   - **Gating:**
     - The `RB_WRITE_TOOLS` flag removes the tools from the catalog on `serve`, the Worker and stdio.
     - `computeAccess` requires explicit names on the project **and** the grant, and a shared or own key.
     - `guardWriteTools` makes create, PATCH and import owner-only.
     - `mcp:write` is a separate unticked consent: never remembered, `prompt=none` gets `consent_required`, and refresh
       only narrows.
     - Pass-through is read-only, and `assertWriteGranted` runs inside every handler.
   - **Cross-account:** issues are read through `lookupIssue` plus an `inScope` check. Change events need the entity
     GUID's account to agree with the call's account.
   - **Dashboard widgets:** every widget NRQL goes through `singleAccount`, `enforceQueryLimits` and the `rawNrql`
     switch. Markdown refuses links, HTML and URLs.
   - **Mutation allow-list:** ADR-0014 lists exactly the four write mutations. The guard read only the first operation,
     which is now hardened (L-doc).
5. **Query cache isolation: no finding.**
   - The entry id is an HMAC (key derived from the master key) over a length-prefixed encoding of:
     - the scope (`project:<id>/grant:<id>`, `stdio`, `passthrough`);
     - the credential id, region and a SHA-256 of the NR key;
     - the accounts and the limits fingerprint;
     - the stats flag, the time bucket and the normalized NRQL.
   - Authorization and limits run before lookup.
   - Relative windows never outlive the TTL. Fixed windows count as settled only 15 minutes after `UNTIL`, so a window
     ending in the future stays relative.
   - Cache API bodies are AES-GCM with the id as AAD, and expiry is re-checked from inside the ciphertext. The memory
     LRU is bounded at 500 entries and 16 MiB.
   - One gap: a cache hit is not counted by quotas (L3).
6. **MCP Tasks: no finding above low.**
   - Ids are 256-bit. The store key is a hash, and records are AES-GCM sealed under a key derived from the id.
   - The owner string (project, grant, token, OAuth client; pass-through key fingerprint and region) is bound as AAD.
     Another grant, device, project or key gets "not found".
   - Expiry is enforced on read and purged.
   - Results use the synchronous call's envelope.
   - Every resumed NerdGraph call counts against quota and budget. A tool removed mid-task completes with
     `RB_AUTH_FORBIDDEN`, and an account removed mid-task makes no call.
   - One gap: there is no compare-and-swap on task records (L, P7-29).
7. **Lazy auth / public catalog: no finding.**
   - The public branch runs before any slug lookup and touches no storage.
   - It only allows `initialize`, `notifications/initialized`, `server/discover`, `ping` and `tools/list`. Everything
     else gets the same 401.
   - Any `Authorization` header takes the authenticated path, where the token is checked before the slug.
   - The catalog is built from static definitions: read tools only, no project data, and a context that throws.
   - Default off.
   - stdio setup mode applies only when every config source is absent, replaces every handler with
     `RB_AUTH_UNAUTHORIZED`, and accepts no key as an argument.
8. **Other areas:**
   - **Charts:** DOM is built only with `createElement` and `textContent`. Messages are checked by
     `event.source === window.parent`. The CSP meta is `default-src 'none'; connect-src 'none'`, and theme variables
     are allowlisted.
   - **OTel:** exports are built from allowlists: no NRQL, arguments, account ids or emails. Log bodies are redacted.
     The endpoint must be https with no userinfo, and `redirect: 'error'` is set. The one gap is a `path` log field
     (L2).
   - **Keychain:** secrets go on stdin, never argv. Names and secrets are validated by regex. The one gap is the bare
     executable names (L1).
   - **Doctor:** it prints fingerprints only and scrubs output against known secrets plus `redact()`. Tokens from
     client configs are never sent. The token check goes only to `--remote`.
   - **DO limiter:** keys are credential or rule ids. A DO error falls back to the isolate bucket, which for `write:`
     means per-isolate (M1).
   - **Quotas:** reservation is one conditional upsert with `RETURNING`, so it is atomic on D1 and SQLite, and the DO
     uses one synchronous statement. Store errors fail open, as documented (L4).

## Per-task completeness

| Task | Result | Notes |
|---|---|---|
| P7-01 result shaping v2 | Met | The "handle" is `detail: "full"` re-running the query, usually a cache hit (decision logged). Token savings were measured on synthetic results only. |
| P7-02 query cache | Met | Isolation as above. Cache hits are not counted by quotas (L3). |
| P7-03 deep links | Partly met | Query-builder and issue link formats are unverified (owner check, logged). JP is refused. |
| P7-04 MCP Apps charts | Partly met | Not rendered in a real host (logged). jsdom, injection and authz tests are present. |
| P7-05 doctor | Met | Client configs and token checks moved to P7-17. |
| P7-06 import/export | Met, H1 fixed | A personal-key default bypassed P4-18. The live Node-to-Worker move was not run (logged). |
| P7-07 Claude Code plugin | Partly met | Publishing is owner-only (logged). `claude plugin validate --strict` passes. |
| P7-08 self-monitoring | Met | |
| P7-09 write tools | Met | Gating holds. The Worker write limit is per isolate (M1), and no owner switch requires approval (M2). |
| P7-10 DO limiter | Partly met | The real 20-client load test needs a deployment (logged). |
| P7-11 keychain | Met | Bare executable names (L1). |
| P7-12 quotas | Met | Fail-open on store errors and a soft inspected-events cap (L4). |
| P7-13 Tasks | Partly met | The real-client criterion is unticked (logged). |
| P7-14 lazy auth / catalog | Partly met | Registry publish is owner-only (logged). |
| P7-16 Apps gating | Met | |
| P7-17 doctor clients | Met | |
| P7-18 OTLP follow-ups | Met | `path` log field (L2). |
| P7-19 `create_dashboard` | Met, H2 fixed | The approval prompt hid widgets past 6000 characters. |
| P7-20 elicitation | Partly met, H2 fixed | Not checked in a real client (logged). Approvals can be replayed for non-idempotent writes (M3). |
| P7-21 insights report task | Partly met | Real-client criterion (logged). |
| P7-22 stdio / pass-through Tasks | Met | Dropped the P7-21 authz cases, which P7-23 restored. |
| P7-23 other composites | Met | |

No ticked box was found unmet, and every "Docs to update" entry was touched. ADR-0015's Decision still says "three
tools", while the P7-19 addendum adds the fourth; this is history, not an error.

## Findings

### Critical

None.

### High

**H1. A config import could make a colleague's personal key a project default (T29, T3, T21).**
`packages/auth/src/transfer/transfer.ts:467` (before the fix):

- Bundle credentials are matched to stored ones by owner email and label. The import then set a project's
  `defaultCredentialId` to a personal key whenever the bundle said so, with only a warning.
- The admin API allows that only when the key's owner makes the change (`guardProjectDefault`, P4-18, from the Phase 4
  review).
- *Impact:* an owner, or whoever holds the admin token, crafts a bundle that names a member's stored personal key, a new
  project defaulting to it, and a service grant or a grant for themselves. They then query New Relic with the member's
  key and rights, and every user of that project does too. The same holds for a file from an untrusted source applied
  by an owner.
- *Fix:* the import applies the API rule. A personal key becomes a project default only when the person running the
  import (`actorUserId`, the session's user; the admin token is nobody) owns it. Otherwise the default is left unset,
  the plan says why, and grants riding on it are skipped.
- *Tests:*
  - `packages/auth/test/config-transfer.test.ts`: crafted bundle against a stored key, run as both another owner and
    the admin token; key owner allowed.
  - `packages/http-app/test/admin.test.ts`: the admin API path.
  - All 3 fail without the fix.
- *Docs:* guide `migrating-config.md`, THREAT_MODEL T29 (both rows), pending decision updated. **fixed**

**H2. A write approval showed a shortened change and bound only the shortened text (T31, T6).**
`packages/core/src/tools/write-common.ts:144-175` and `writes-dashboard.ts:351-366` (before the fix):

- The elicitation message was cut at 6000 characters, with each NRQL and markdown cut at 300. Dashboard and page
  descriptions were not shown at all.
- The answer key was a hash of the shortened message.
- *Impact:* a person approving a `create_dashboard` (up to 40 widgets of 4096-character NRQL) saw only the first part.
  Probe-confirmed: a 21-widget, 2-page dashboard lost the last widget and the whole second page, then was created on
  accept.
- On the stateless 2026-07-28 path, an approval also matched any change whose hidden or normalized part differed:
  whitespace, redacted strings, or text past the cut.
- *Fix:*
  - Every field that is sent is shown in full.
  - A message over 16 000 characters is refused with `RB_INPUT_INVALID` before anything is asked or sent.
  - The key hashes the message **and** the exact change: the dashboard mutation variables, the parsed change-event
    arguments, or tool + account + issue id.
- *Tests:* `packages/core/test/tools-writes.test.ts` "approval shows and binds the whole change" (3 tests, all fail
  without the fix).
- *Docs:* ADR-0015 addendum, THREAT_MODEL T31 row. **fixed**

### Medium

**M1. The Worker's write rate limit is per isolate.**

- *Where:* `apps/worker/src/rate-limit.ts` (`take`). The "fails closed" claim is in `rate-limit-hooks.ts`.
- *Without `RB_SHARED_LIMITER`:* `write:` keys are per isolate, so the 20-per-hour cap is not deployment-wide.
- *With it:* a Durable Object error falls back to the isolate bucket instead of refusing.
- *Impact:* a multiple of 20 writes per hour per grant. It is not unlimited.
- **task P7-24**, with the owner decision on warn vs refuse logged.

**M2. A client that cannot be asked lets the model approve its own write.**

- This affects clients with no elicitation, and every 2025-era client on stateless HTTP and Workers. Such a client
  writes on `confirm: true` alone.
- This is the documented P7-09 behaviour. However, an owner cannot require a human approval.
- **task P7-25**, decision logged.

**M3. Approvals can be replayed.**

- The key has no nonce or expiry. Resending identical `inputResponses` repeats `create_change_event` or
  `create_dashboard`, which are not idempotent.
- ADR-0015 calls a stale approval "harmless", but it is not harmless for these two tools.
- **task P7-26**

**M4. `tools/list` budget gaps.**

- The budget covers built-in tools only, and they are 33 characters under it (the budget was raised during Phase 7).
- Write tools add about 8.1k characters, which nothing guards.
- **task P7-27**

**M5. A non-owner admin can widen a write-enabled project or grant.**

- `guardWriteTools` blocks only adding write tool names.
- `allowedAccountIds`, `defaultCredentialId`, `rawNrql` and the limits of a project that already writes stay
  admin-editable.
- Related lows:
  - The write audit row is written after the mutation, in the background. `createHttpApp({ writeTools: true })` accepts
    no audit hook.
  - The access cache keeps a revoked write grant alive for up to 30 s per isolate.
- **task P7-28**

### Low

| Id | Finding | Handling |
|---|---|---|
| L-doc | `defineDocument` checked kind, name and allow-list of the **first** operation only. `query RbOk {…} mutation RbEvil {…}` passed (`nerdgraph/document.ts:68`). No shipped document is affected. | **fixed**: exactly one operation, no comments; test in `nerdgraph-misc.test.ts` |
| L1 | Keychain spawns `powershell.exe` and `security` by bare name (`apps/cli/src/keychain.ts`). On Windows, a planted executable in the working directory would receive the secret. | P7-30 |
| L2 | The OTLP log `path` field allowlist lets filesystem paths through (`telemetry.ts`, `serve.ts` logs `dbPath`). | P7-30 |
| L3 | Quotas do not count query-cache hits, so a grant at its cap is served cached rows for up to 30 s / 10 min. | P7-30 |
| L4 | Quota counter-store errors fail open, and the inspected-events cap overshoots under parallel calls. Both are intended but under-documented. | P7-30 |
| L5 | `list_alert_conditions` keeps rows with no `entityGuid` after a forged upstream cursor (`alerts.ts:271`). | P7-30 |
| L6 | Unbound offset cursor helpers in `output/compact.ts` have no caller. | P7-30 |
| L7 | A whitespace-only `NEW_RELIC_API_KEY` silently enters stdio setup mode. | P7-30 |
| L8 | The "ungranted tools" authz test takes about 18 s and times out under load. | P7-30 |
| L9 | Only one changeset exists for Phase 7. ROADMAP/README status is stale. The `checkPeriods` import in `apps/worker/src/shared-limiter.ts` is unused. | P7-30 |
| L10 | Task records have no compare-and-swap. Two concurrent polls can both run a step, and a poll can overwrite `cancelled`. | P7-29 |
| L11 | Authenticated callers may choose their trace id when `RB_OTEL_TRACEPARENT=on`. Nothing security-relevant reads it. | accepted (T30) |

## Local CI

GitHub Actions is unavailable (billing). Results are from WSL2 Linux on Node 24, with Docker available. During this
review, other projects' test suites were running on the same machine (load average 8 to 13).

**Baseline run** on the unchanged stack tip (`task/P7-23-tasks-remaining-reports`), while four sub-reviews were also
running tests:

- `lint` and `typecheck` passed.
- `pnpm test` reported 4,038 passed, 24 failed and 18 skipped, in 2,433 s, against about 260 s normally.
- Every failure was a 5 s timeout in an e2e, SDK or PBKDF2 test.
- The same files pass when run alone, and in the final runs below.

Final run on this branch (sequential):

| Command | Result |
|---|---|
| `pnpm lint` | pass (biome, runtime imports, NRQL templates, UI escaping, SPDX, tasks, generated docs/migrations/assets, version sync) |
| `pnpm typecheck` | pass |
| `pnpm test` (run 1) | 4,067 passed, 1 failed, 18 skipped (1,824 s under load): `apps/cli/test/e2e.test.ts` "--version and --help" hit the 5 s default (two cold CLI starts); given an explicit 30 s timeout on this branch, the file then passed (8/8) |
| `pnpm test` (run 2) | pass: 211 files, 4,068 passed, 18 skipped (904 s) |
| `pnpm test:workers` | pass: 37 files, 653 passed, 9 skipped (workerd + D1 simulator) |
| `pnpm test:authz` | pass: 23 files, 486 passed, 1 skipped (authorization matrix) |
| `pnpm build` | pass |
| `pnpm bench:cpu` | pass, one run (0.81x … 1.52x; `cold.first-request` 1.52x, `mcp.tools-list.*` 1.24x/1.25x; threshold 2x) |
| `pnpm docs:tools` | pass, no diff |
| `pnpm test:e2e` (Playwright) | pass: 4 tests (admin and OAuth flows, desktop and mobile-320) |
| Offline tool-description checks (`tool-descriptions.test.ts`, `eval-tools.test.ts`, inside `pnpm test`) | pass; `pnpm eval:tools` (LLM) not run: no API key, never called |
| `claude plugin validate --strict` (plugin and marketplace) | pass |
| Docker image build + `scripts/docker-smoke.sh` | pass (health, foreign Host refused, backup, CLI setup, 37 MCP tools, uid 65532, read-only rootfs); image and containers removed |
| `pnpm scan:zap` (OWASP ZAP baseline) | pass: 118 rules pass, no unreviewed Medium/High alert |
| actionlint 1.7.12 (container) on `.github/workflows/*` | pass, no findings |

`cold.first-request` moved from about 1.25x (Phase 6) to 1.52x of the Phase 5 baseline: more tools, Tasks and the write
module to load. It is within tolerance but trending; Phase 8 benchmarks should re-baseline or trim cold-start work.

## What Phase 8 must know

1. **Live verification is the biggest open item.** The following have only been checked against mocks or simulators:
   - mutation shapes;
   - Apps rendering;
   - Tasks and elicitation in a real client;
   - the DO limiter under load;
   - UI link formats;
   - a Node-to-Worker config move.

   Run `pnpm test:live` and a client checklist on a test account before 1.0, and tick the eight open criteria.
2. **Threat-model review: write tools are the new top risk (T31).**
   - Decide P7-25 (require human approval), P7-24 (deployment-wide write limit) and P7-28 (owner-only scope widening,
     audit before mutation) before 1.0.
   - The approval is only as trustworthy as the client. Fuzz the elicitation retry path (`inputResponses`) and the
     `defineDocument` guard.
3. **Fuzzing targets:**
   - the cursor decoder (`paging.ts`);
   - the config bundle validator (`transfer/bundle.ts`) and the import planner;
   - task record unsealing;
   - the public-catalog body peek (`peekJsonRpc`);
   - the chart view's `postMessage` handler;
   - the OTLP attribute allowlist.
4. **Owner boundary:** every new path that writes a project or grant (import, API, UI, future ones) must apply
   `guardProjectDefault` and `guardWriteTools`. H1 was the import repeating a rule the API already had. An independent
   reviewer should diff every writer of `defaultCredentialId`, `tools` and `accountIds`.
5. **Benchmarks:** `cold.first-request` and `mcp.tools-list.hit` grow with each tool. The `tools/list` budget has no
   headroom (P7-27).
6. **Release hygiene:** changesets are missing for most of Phase 7 (P7-30). ROADMAP and README still describe Phase 6
   as current.
