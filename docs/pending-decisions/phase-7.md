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

### P7-08 — Self-monitoring: exporter design and Free-plan cost chosen without an owner
- **Context:** The task asks for OTLP export of traces, metrics and logs, including budget usage, on Workers and Node.
- **Assumption made:** A hand-written OTLP/HTTP **JSON** exporter (no OpenTelemetry SDK; web-standard, no bundle growth)
  for traces and metrics only, one export per tool call run through `waitUntil`, delta metrics, no batching. Logs, budget
  usage (not on the tool call event), stdio and client trace context are deferred to P7-18. The exported attribute set
  includes the project slug and tool name. Each export is 1 to 2 subrequests, which count against the Workers Free
  50-subrequest limit (not the NerdGraph budget); documented, and `RB_OTEL_SAMPLE` lowers it.
- **Options:** adopt `@opentelemetry/*` (heavier, Node-centric); batch per isolate with periodic flush (fewer subrequests,
  but data lost on eviction); drop the `project` attribute; protobuf encoding.
- **Needs:** owner confirms the attribute set (project slug) is acceptable to send to a third party, whether Free-plan
  users should be warned or capped, and a real check against New Relic's OTLP endpoint with a license key, which this run
  could not do.


### P7-09 — Write tools: enabling writes at all is an owner decision
- **Context:** The task adds tools that change New Relic. AGENTS.md says tools are read-only unless a task says
  otherwise; this one does, but whether a deployment should ever offer writes is the owner's call, and none of the
  mutations could be run against New Relic during the autonomous run.
- **Assumption made:** Built and shipped **off** at every layer (ADR-0015): server flag `RB_WRITE_TOOLS=on`, explicit
  names on the project **and** the grant (never through "all tools"), owner-only in the admin API, a shared or own key
  only, OAuth `mcp:write` with a separate unticked consent box (never remembered, never silent), never pass-through.
  Three tools: `create_change_event`, `acknowledge_issue`, `close_issue` (destructive). `create_dashboard` moved to
  P7-19; elicitation-based confirmation to P7-20 (the model sets `confirm: true` today). Write rate limit 20 per hour
  per grant, failing closed (per isolate on Workers until P7-10). `serve` and the Worker refuse writes with
  `RB_AUDIT=off`. stdio logs each write to stderr instead of an audit row.
- **Options:** keep writes unbuilt/unshipped until verified; drop `close_issue` (the only irreversible one); require a
  separate project flag in addition to explicit names; allow writes on pass-through behind its own flag; different
  rate-limit default; require the audit log on stdio too (a file).
- **Also assumed:** the local `relic-bridge project/grant` commands cannot name write tools (read-only catalog; use the
  admin API/panel as an owner); `mcp:write` is listed in the protected resource metadata when on, but the 401 challenge
  keeps `scope="mcp:read"` (a client that asks for every advertised scope shows the write box each time and loses
  "don't ask again"); writes with `RB_RATE_LIMIT=off` only warn.
- **Needs:** (1) the owner's explicit decision to enable writes on any deployment (and ADR-0015 confirmation);
  (2) a live check of each mutation (RESEARCH §26: field and argument names, category/type case for change events)
  with `dry_run` first, then one real call on a test entity/issue in US and EU; (3) whether `close_issue` should ship.
- **Update (P7-10):** P7-10 addresses this: with `RB_SHARED_LIMITER=rules` or `on` the 20-per-hour write limit is counted per grant for the whole deployment; an unreachable object falls back to the isolate bucket (still a limit). See docs/guide/cloudflare-limits.md#shared-limiter-durable-object-optional.

### P7-10 — Durable Object limiter: opt-in, defaults and failure policy chosen without an owner
- **Context:** The task asks for an optional Durable Object semaphore per credential; the owner also asked to consider
  reusing it for the per-isolate rate rules. Nothing could be deployed, so cost and latency are from documentation only.
- **Assumption made:** One SQLite-backed class `SharedLimiter`, declared in the committed `wrangler.jsonc` with the
  declarative `exports` field (current Cloudflare recommendation for new Workers; once deployed with `exports` a Worker
  cannot go back to `migrations`) and bound as `SHARED_LIMITER`, so every new deploy gets an (unused, free) namespace.
  It is used only with `RB_SHARED_LIMITER`: `off` (default), `rules` (`fail:`, `signin:`, `oauth:`, `write:` counted
  deployment-wide), `on` (also NerdGraph concurrency per credential). `ip:`/`token:`/`grant:`/`key:` stay on the Rate
  Limiting binding. Leases 60 s, queue wait 10 s (then `RB_LIMIT_RATE`), queue 256; leases in memory only. An
  unreachable object (outage, Free daily limit) falls back to per-isolate counting for every rule, including the
  security rules (`fail:`) and the write limit, rather than failing closed (a Durable Object outage would otherwise
  refuse every sign-in/OAuth/write request). Existing `wrangler.local.jsonc` copies lack the binding: the Worker warns.
- **Options:** default `rules` on (cheap; changes behaviour for existing deployments); fail closed for `fail:`/`write:`
  when the object is unreachable; use `migrations` instead of `exports`; move `ip:`/`token:`/`grant:` to the object
  (exact limits, one more round trip per request); persist leases (two row writes per NerdGraph call); tune lease/wait.
- **Needs:** owner's call on the default and the failure policy; on a deployment, measure the added latency per call
  and confirm 429s disappear under a real 20-client load on one key (acceptance criterion left open).

### P7-11 — OS keychain: shell-out backends, no native module; macOS and Windows unverified
- **Context:** The task asked for a maintained library. `keytar` is archived and `@napi-rs/keyring` is a native addon
  (per-platform optional dependencies), which conflicts with the one-file package that P1-15 enforces and with `npx`.
- **Assumption made:** No dependency. `security -i` (macOS), `secret-tool` (Linux) and Windows PowerShell `PasswordVault`
  (Windows) are run with the secret on stdin. `credential add --keychain` was replaced by `relic-bridge keychain
  set|delete|status` (`credential add` stores keys in the database, where a keychain entry has no meaning); references
  are `apiKey: keychain:<name>` and `RB_MASTER_KEY(_PREVIOUS)_KEYCHAIN`. No automatic fallback when the keychain is
  unavailable (fail closed). WSL2 uses the libsecret backend inside the distro; the Windows store is not bridged.
- **Options:** adopt `@napi-rs/keyring` as an optional dependency and relax P1-15 for it; bridge WSL2 to the Windows
  store through `powershell.exe` interop; an encrypted-file fallback; keychain support for the admin token and IdP
  secrets; `keychain set --generate-master-key` so the master key is never displayed.
- **Needs:** run `relic-bridge keychain set/status/delete` once on a real macOS, a real Windows and a Linux desktop with
  gnome-keyring (this machine's WSL2 has no Secret Service, so only the "unavailable" path was exercised live). Confirm
  `security -i` returns a failing status on a refused add (the code also reads back, so a silent failure is caught), and
  that macOS prompts acceptably when the keychain entry is read by a node process started by an MCP client.

### P7-12 — Per-grant quotas: counting rules, failure policy and calendar periods chosen without an owner
- **Context:** The task asks for daily query quotas and inspected-events budgets per grant, with soft warn and hard deny,
  and a usage dashboard. Nothing could be deployed, so D1 write cost and latency come from documentation only.
- **Assumption made:** (1) A quota counts **logical NerdGraph calls** (retries of one call count once; query-cache hits,
  `tools/list` and calls refused before New Relic count nothing) and **inspected events** (NRQL asks for cost stats while
  the budget applies and the stats are dropped again when the caller did not ask; the budget is checked before a call, so
  it can be overshot by the queries in flight). (2) Periods are UTC calendar **day and month** (no rolling window; the
  task says day/month). (3) **Fail open:** if the counter store cannot be reached the call is allowed with one warning per
  request, because a cost control should not turn a D1 or Durable Object outage into a tool outage; the Durable Object path
  falls back to the D1 table instead of to unlimited. (4) Counters are one atomic upsert per New Relic call per period
  (storage, atomic on SQLite and D1); with `RB_SHARED_LIMITER=on` they live in one Durable Object per grant. (5) Quotas
  apply to grants only (not stdio, not pass-through keys). (6) The only grant change allowed in place is the quota
  (`PUT /grants/{id}/quota`); an import does not change an existing grant's quota (the P7-06 rule for existing grants).
  (7) Soft warning default 80%, one extra text line per result; hard deny is `RB_LIMIT_QUOTA`.
- **Options:** fail closed on a counter error; count declared tool costs; count cache hits (separately); rolling windows;
  per-project or per-user (across grants) quotas; allow an import to update an existing grant's quota; a CLI flag
  (`grant create --quota-day-queries`); email or webhook alerts at the warning threshold; reset counters when a quota is
  lowered.
- **Needs:** owner's call on fail-open vs fail-closed; whether D1 write cost per call is acceptable (one or two writes per
  New Relic call for a grant with a quota; the shared limiter avoids it) or whether quotas should be Durable Object-only
  on Workers; on a deployment, measure the added latency per call and confirm a cap holds across isolates under load.

### P7-13 — MCP Tasks: hand-rolled on SDK 2.2.0, `run_nrql` only, HTTP project routes only, no real client verified
- **Context:** The MCP TypeScript SDK 2.2.0 has no Tasks runtime for protocol 2026-07-28 (`tasks/*` answer `-32601`);
  `@modelcontextprotocol/ext-tasks` 0.2.x is client-side only. No Tasks-capable client could be run (no deployment, no
  live calls), so "works with at least one client" is verified only against the spec with raw JSON-RPC requests.
- **Assumption made:** (1) The project MCP route answers `tasks/get|update|cancel` itself (after authentication, rate
  limits and `beforeMcp`), and a tool result becomes a task through a small wrapper of the SDK's private output check
  (tests fail if an SDK upgrade breaks it); the task answer also carries an empty `content` array, which the SDK's
  `tools/call` result check requires and clients ignore. (2) Only `run_nrql` creates tasks (async submit, no in-request polling);
  composite reports are P7-21. (3) Tasks only on `serve` and the Worker project routes; stdio and pass-through keep the
  `queryId` handle (P7-22). (4) A task is visible to the creating **device** only (project + grant + token or OAuth
  device), not to the grant's other devices. (5) Fixed 15-minute TTL, poll interval from New Relic's `retryAfter`
  clamped to 1-10 s, a poll before the interval does no work; no server-side poller and no `notifications/tasks`
  (stateless: nothing runs after a response). (6) Records live in the storage `kv` table, sealed under a key derived
  from the task id (not the master key): the database alone can't open them, and rotation of the master key does not
  touch them. (7) Transient failures (rate limit, quota, budget, NerdGraph unavailable) keep the task working;
  everything else completes it with the tool's error result (never `failed`: that status is for JSON-RPC errors).
  (8) No new dependency, no new setting: on whenever the host passes a task store.
- **Options:** let every device of a grant see its tasks; a setting to turn Tasks off (`RB_TASKS=off`); longer TTL;
  adopt the SDK's Tasks support when it ships and drop the hand-rolled route; a Durable Object poller with
  notifications (P7-22); add the `ext-tasks` client as a dev dependency for an end-to-end conformance test.
- **Needs:** on a deployment, run one Tasks-capable client (e.g. an `ext-tasks` client session, or a host that lists
  Tasks support) against `/p/<slug>/mcp` with a slow query, and tick the client criterion in the task file; owner's call
  on (4) and on an off switch.

### P7-14 — Lazy auth: stdio setup mode on by default, remote public catalog opt-in, registry not published
- **Context:** The task wants registries and OAuth-first clients to list tools before authenticating, without a project
  existence oracle. The 2026-07-28 spec neither requires nor forbids unauthenticated `initialize` / `tools/list`.
  Publishing to the MCP Registry needs the maintainer's GitHub sign-in and a published npm package.
- **Assumption made:** (1) **stdio setup mode is the default** when nothing at all is configured (no key, no account id,
  no config file): the tools are listed and every call answers `RB_AUTH_UNAUTHORIZED` with a setup hint; a partial
  configuration still exits 1. Previously a bare `npx relic-bridge` exited 1 with `NEW_RELIC_API_KEY is not set`, which
  clients show in their logs only; now they show a connected server whose calls explain the setup. (2) **Remote: opt-in
  `RB_PUBLIC_TOOL_CATALOG`** (off by default) instead of a separate endpoint: discovery methods without an
  `Authorization` header are answered on `/p/<any>/mcp` from the static read-only catalog, identical for every slug, plus
  `/.well-known/relic-bridge/tools.json`. The list is the built-in read-only tools, not the deployment's affordable
  subset (the Workers Free plan budget may hide a few tools after sign-in) and never write tools. (3) `server.json`
  lists the npm package only (no `remotes`, no OCI image: the image is a self-hosted HTTP server that needs a master key
  and a URL, which the registry cannot describe usefully), under `io.github.matiashidalgo/relic-bridge`. (4) No MCP
  Server Card (SEP-2127 is a draft with no settled path).
- **Options:** keep stdio failing fast (setup mode behind a flag such as `--list-only`); serve the public catalog on a
  separate path (e.g. `/mcp`) instead of the project routes; include the deployment's affordable subset; add the OCI
  image and a templated `remotes` entry (`https://{host}/p/{project}/mcp`); publish a server card once ratified.
- **Needs:** owner's call on (1) and (2); then, after the first npm release, publish with `mcp-publisher login github`
  and `mcp-publisher publish` (and decide whether the release workflow should do it with GitHub OIDC). Verify with
  a real registry/inspector (e.g. MCP Inspector against a deployment with the catalog on) that discovery works and that
  OAuth-first clients still sign in at the first tool call.

### P7-16 — MCP Apps: unknown capabilities still get the view; per-request getters on SDK objects
- **Context:** The view should go to clients that declare `io.modelcontextprotocol/ui`. On 2026-07-28 the declaration is
  in every request; on stdio it is in `initialize`; a stateless 2025-era HTTP request has no capabilities at all (the
  `initialize` was another request). The SDK's list handlers get no request context.
- **Assumption made:** (1) Hide the view only when capabilities are present and lack the declaration; when nothing is
  known (2025-era stateless HTTP) keep offering it, as before P7-16 (clients that ignore it lose nothing, and hiding
  would remove charts for clients on that path that do support it). (2) Gate per request by defining `_meta` (tool) and
  `enabled` (resource) as getters on the SDK's registered objects, which relies on SDK 2.2.0 internals (covered by
  tests on HTTP, Worker and stdio; they fail if an SDK upgrade changes it). (3) A client that did not declare support
  also cannot read the `ui://` URI. (4) `RB_MCP_APPS` accepts on/off only, default on.
- **Options:** treat unknown as "no" (strictest, drops charts for 2025-era stateless clients); use only the switch and
  skip per-client gating; ask the SDK for a per-request list hook and drop the getters.
- **Needs:** owner's call on (1); verify in a real MCP Apps host (Claude web or Desktop) that charts still render.
