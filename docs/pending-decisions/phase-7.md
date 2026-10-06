# Phase 7 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/7-power-features` (itself stacked on the tip of Phase 6, `task/P6-24-consistent-paging`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## Tools

### P7-01 — summary defaults and the "handle" for full pages
- **Context:** The task asks for summaries by default and "full pages via handle". There is no server-side result
  store until the query cache (P7-02).
- **Assumption made:** `detail: auto` summarizes timeseries and faceted results of 50 rows or more (raw-event lists
  never, the agent needs the rows); thresholds (25 rows kept, 24 points x 10 series, 5000 rows read) are constants in
  `packages/core/src/output/summarize.ts`. The "handle" is `detail: "full"` + `max_rows`, which re-runs the query.
  The bench baseline `tool.run_nrql.summary2000` (9.6 ms calibrated) was measured on a noisy machine, so it is
  generous; it is dominated by parsing a 2000-row response.
- **Options:** keep as is; make `summary` the default for raw events too; add a cache-backed paging handle in P7-02.
- **Needs:** owner's call on the thresholds, and whether P7-02 should add result paging by handle. The 50% token
  target is verified on synthetic large results only, not on the live LLM eval (no live calls allowed).

### P7-02 — query cache defaults
- **Context:** The query cache is on by default everywhere (moving windows reused for 30 s, settled fixed windows for
  10 min). On Workers the per-colo Cache API costs one subrequest per lookup/write.
- **Assumption made:** `RB_QUERY_CACHE` defaults to `on` for `serve`/stdio (memory) and for the Worker on the paid
  plan (memory + Cache API), and to `memory` on the Free Worker plan (45-subrequest budget). Cache API calls stop once
  half the request budget is spent. Entries are scoped per grant (not per project or credential), the strictest scope
  that still lets one grant's devices share answers. `run_nrql` alone takes `cache: "bypass"`; other tools have no
  per-call switch (their queries are reused for the same TTL). The P6 review suggestion "refund budget on hits" is moot:
  a memory hit never spends budget, a Cache API hit spends one unit (it is a real subrequest).
- **Options:** default off (opt-in); shorter/longer default TTL; share entries per project or per credential instead of
  per grant (more hits, same New Relic answers, but a grant edit could briefly be outlived by cached results of the
  old grant's limits; the limits fingerprint already prevents that); add `cache` to every NRQL tool.
- **Needs:** owner's call on the defaults and the scope.

### P7-02 — result paging by handle (follow-up from P7-01)
- **Context:** P7-01 asked whether P7-02 should add a cache-backed paging handle for full results.
- **Assumption made:** Not added. `detail: "full"` re-running the query is now usually a cache hit (same NRQL within
  the TTL), which gives most of the benefit without a new handle format to secure.
- **Options:** add `result_handle` + `page` to `run_nrql` backed by the cache entry id (needs a handle bound to the
  caller's scope so it can't be replayed by another grant).
- **Needs:** owner's call; a new task if wanted.

### P7-03 — UI link formats are unverified
- **Context:** The autonomous run had no browser or New Relic login, so only the entity permalink is a known format.
- **Assumption made:** Query builder (`launcher` + base64 `pane`) and issue (`alerts-ai/issues/<id>`) formats are best
  recollection; the tool marks them `verified: false` and its description says so. JP is refused (no known host). The
  tool is one new tool (~770 characters), so the `tools/list` budget went from 53 600 to 54 400. Links are not added to
  other tools' output to avoid growing every result.
- **Options:** verify and fix the two formats (one-line change in `packages/core/src/links.ts`); add `link` fields to
  `get_entity` / `list_recent_issues` / `get_dashboard`; drop the unverified kinds.
- **Needs:** owner opens one link of each kind in US and EU and reports; then drop the "unverified" wording.

### P7-04 — MCP Apps charts: always advertised, unverified in a real client
- **Context:** No MCP Apps host was available in the autonomous run, so "renders in at least one Claude surface" is
  not verified. The view follows the stable spec 2026-01-26 and is tested in jsdom through its postMessage protocol.
- **Assumption made:** The `ui://relic-bridge/nrql-chart` resource and `_meta.ui` on `run_nrql` / `get_query_result`
  are offered to every client whose connection allows `run_nrql` (clients without MCP Apps ignore them); no capability
  check and no switch (follow-up task P7-16). Both the current `_meta.ui.resourceUri` and the deprecated flat
  `_meta["ui/resourceUri"]` are sent for older hosts. Tools are `visibility: ["model"]` (the view can't call tools).
  The page carries its own `<meta>` CSP (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  connect-src 'none'`), on top of the host's.
- **Options:** gate on the client capability and add `RB_MCP_APPS` (P7-16); drop the deprecated key once Claude is
  confirmed on `ui.resourceUri`; tighten the meta CSP to script/style hashes (risk: a host that injects a bootstrap
  script would be blocked; unknown); chart more tools (golden metrics, `analyze_*`).
- **Needs:** owner connects a deployed server to claude.ai or Claude Desktop, runs `SELECT count(*) FROM Transaction
  FACET appName TIMESERIES SINCE 1 hour ago`, and reports whether the chart shows (and in which theme); then tick the
  last P7-04 criterion and update `docs/reference/client-compatibility.md`.

### P7-05 — doctor: scope trimmed, probes chosen without an owner
- **Context:** The task listed client-config-file checks and remote token validity. Both need per-client file parsing
  and a token input that must not be a flag.
- **Assumption made:** Moved to follow-up P7-17. Doctor exits `1` only on `fail` (warnings exit `0`). The remote MCP
  probe is an unauthenticated `POST /p/doctor-probe/mcp` (expects 401); the Workers drift check duplicates
  `normalizeConfig` from `scripts/cloudflare-setup.ts` (the CLI cannot import scripts) and only looks at the default
  `wrangler.local.jsonc`. The New Relic clock check issues a `HEAD` to the region's NerdGraph endpoint.
- **Options:** add `--strict` (warnings exit 1); move `normalizeConfig` into a shared package; drop the clock probe to
  keep `doctor` to a single NerdGraph request.
- **Needs:** owner confirms the exit-code policy and whether the unauthenticated probe is acceptable against servers
  with WAF/rate limits.

### P7-06 — Config import/export: KDF, personal-key defaults and scope chosen without an owner
- **Context:** The task said "age/scrypt". WebCrypto has neither scrypt nor Argon2, and `packages/auth` must stay
  web-standard (ADR-0004). Workers also cap PBKDF2 at 100 000 iterations, below what is sensible for a passphrase.
- **Assumption made:** PBKDF2-HMAC-SHA-256 at 600 000 iterations (OWASP) with AES-256-GCM, run **in the CLI**; the Admin
  API receives only the derived wrap key (never the passphrase) and the format is versioned (`version: 1`,
  `secrets.kdf`). Import never deletes, never creates `owner` users, never modifies existing users or grants, keeps stored
  keys, and is not transactional (stops at the first failure; re-running resumes). A personal key may become a project
  default through an import (the admin API refuses that unless the key's owner makes the change) because the importer is
  an owner and the file reproduces another deployment; the plan warns. The 64 KiB admin body limit bounds bundle size. Export seals only shared keys and the caller's own personal keys (the
  admin token and the CLI are nobody: shared keys only), so an owner cannot exfiltrate a colleague's key; the personal keys of
  other people must be re-added on the target. Large imports on the Workers Free plan (50 D1 queries per request) stop with
  503 and resume on re-run.
- **Options:** add `scrypt`/Argon2 through a vetted pure-JS dependency in the CLI only (the KDF runs client side, so it
  would not touch Workers) and bump the format version; refuse personal-key defaults like the API does; add
  `--prune`/update-existing-grants; raise the body limit for `/config/import`; a `--wrap-key-file` for automation.
- **Needs:** owner confirms PBKDF2 is acceptable (or asks for Argon2id in the CLI), whether personal-key defaults should
  be refused on import, and whether existing grants should be updatable. Also run one real Node-to-Worker move (export
  with `--with-credentials`, `import --apply --remote https://<worker>`) against a deployed Worker, which this run could not.

### P7-07 — Claude Code plugin: publishing, versioning and packaging chosen without an owner
- **Context:** The task asks for marketplace listing and publishing to the official MCP Registry. Publishing is an
  external, owner-only action; relic-bridge is also not on npm yet.
- **Assumption made:** Only the manifests are prepared: `plugins/relic-bridge/` and a root `.claude-plugin/marketplace.json`
  (source `./plugins/relic-bridge`, so the GitHub repo is itself a marketplace). The default `.mcp.json` is local stdio via
  `npx -y relic-bridge`; the remote variant is a template (`mcp-remote.example.json`) because one file cannot offer both
  without a failing server entry. The plugin version (0.1.0) is not yet synced by `scripts/release.ts`.
- **Options:** publish to a community marketplace and the MCP Registry; use plugin `userConfig` prompts instead of
  environment variables; bundle both servers; add the plugin to the release version sync.
- **Needs:** owner decides whether/where to publish (after the v0.1 npm release), the GitHub owner/repo name in
  `plugin.json` (`homepage` assumes `matiashidalgo/relic-bridge`), and whether to sync the plugin version in releases.
  Also a real `/plugin install` smoke test with a live key, which this run could not do.
