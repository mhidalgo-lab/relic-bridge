# Phase 8 — pending decisions

Decisions left to the owner by the 2026-10-14 run (P8-01, P8-03, P8-04, P8-05, P8-07, P8-52, P8-57 to P8-63). Each
entry says what was assumed so work could continue. Answer in place, or move the outcome into an ADR or task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Observability

### P8-59 — How New Relic counts server errors (PR #231)
- **Context:** New Relic counts an error on `rpc.server.duration` only when `rpc.grpc.status_code` is 2, 4, 12, 13, 14
  or 15; `error.type` is ignored there, so the service error rate stayed 0.
- **Assumption made:** (a) set `rpc.grpc.status_code` on server errors only, a documented deviation (we are JSON-RPC).
- **Options:** (a); (b) export `http.server.request.duration` (loses per-tool names, nothing for stdio); (c) the newer
  `rpc.server.call.duration` once New Relic documents it.
- **Needs:** confirm (a); confirm the changeset level (minor); confirm that a refused stored key is a server error and
  that budget exhaustion is a caller error.

## Tools
- **Decision (2026-10-14):** option (a), `rpc.grpc.status_code` on server errors only; changeset minor; a refused stored key is a server error, budget exhaustion a caller error.

### P8-57 — Error group lookup not verified live (PR #232)
- **Context:** `errorGroups(filter.ids)` returning the group for ids from `list_error_groups` is unverified.
- **Assumption made:** it does; RESEARCH.md marks it as unverified.
- **Needs:** one `trace_error(error_group_id)` call after deploy.

## Policy
- **Decision (2026-10-14):** verify with one `trace_error(error_group_id)` call after the next deploy.

### P8-05 — Windows and backports (PR #236)
- **Context:** the policy proposes "next major and at least 6 months" for deprecations after 1.0 and 3-month backports
  to the previous minor. `release.yml` only releases from `main`, so a backport needs a maintenance-branch path.
- **Needs:** confirm the windows; decide the backport release path before 1.0; decide whether the CI lint job fetches
  tags so the DB-fixture check runs fully in CI (recommended).
- **Decision (2026-10-14):** windows accepted as proposed; backports through `release/x.y` branches before 1.0 (P8-68); the CI lint job fetches tags; deprecated-config warnings are built (P8-67).

### P8-63 — `tools.listChanged` on HTTP (PR #239)
- **Context:** the team asked for `listChanged: true` so clients see new parameters without a reconnect.
- **Assumption made:** keep the stateless transport (ADR-0005); document "reconnect after upgrades".
- **Options:** keep; rely on `ttlMs: 0` cache hints where clients honour them; sessions + notifications (new ADR, Durable
  Objects on Workers).
- **Needs:** owner choice.

## Docs site
- **Decision (2026-10-14):** stay stateless (ADR-0005); users reconnect after upgrades.

### P8-04 — Pages, versioning, third-party image (PR #235)
- **Needs:** enable GitHub Pages (source: GitHub Actions) before the first deploy; confirm "latest from `main`" now and
  per-release snapshots only on demand; keep or self-host the Deploy-to-Cloudflare button image.
- **Decision (2026-10-14):** Pages enabled (source: GitHub Actions); publish latest from `main` with a banner; self-host the button image so the site makes no third-party requests.

### P8-03 — Machine details in the benchmark table (PR #230)
- **Context:** the published table names the CPU model and memory of the machine that ran it.
- **Options:** keep; replace with a generic "developer laptop (WSL2)".
- **Needs:** owner choice.

## CI
- **Decision (2026-10-14):** generic label ("developer laptop, 6-core x86-64, WSL2").

### P8-07 — Environments and egress blocking (PR #228)
- **Needs:** set the `live` and `staging` environments to deploy from `main` only; switch the release jobs'
  harden-runner to `egress-policy: block` after the next release run gives an allowlist; optionally a Renovate regex
  manager for the pinned actionlint and gitleaks digests.

## Security review
- **Decision (2026-10-14):** `live` (required reviewer) and `staging` deploy from `main` only, done; `block` for the release jobs after the next release (P8-69); Renovate regex manager for the pinned digests (P8-70). CI moves to GitHub-hosted runners only (P8-64).

### P8-01 — Follow-ups from the threat model walk (PR #240)
- **Needs:** decide which ASVS open items become tasks before 1.0 (proposed: cryptographic inventory, logging inventory,
  re-authentication for sensitive admin actions); remembered consent for dynamically registered OAuth clients; HSTS by
  default when `RB_PUBLIC_URL` is https. Other findings were reported to the owner privately (SECURITY.md).
- **Decision (2026-10-14):** cryptographic inventory (P8-71), logging inventory (P8-72) and admin re-authentication (P8-73) before 1.0; remembered consent only for metadata-document clients (P8-65); HSTS on by default for an https public URL (P8-66); other follow-ups filed as P8-74 to P8-78.

## ASVS refresh

### P8-95 — Remediation time frames for third-party advisories (SECURITY.md)
- **Context:** ASVS V15.1.1 asks for documented time frames per severity for third-party components. SECURITY.md only
  had targets for reports against relic-bridge itself.
- **Assumption made:** critical 7 days, high 14 days, moderate 30 days, low at the next scheduled update or 90 days,
  counted from when we learn of an advisory that affects a version we ship. Only high and above block a merge
  (`pnpm audit --audit-level high`, dependency review, image scan); moderate and low are tracked through Renovate and
  fixed within their time frames. V15.1.1 and V15.2.1 are marked met on this basis.
- **Options:** keep these values; shorten them (for example critical 3 days, high 7); gate moderate advisories in CI
  too (`--audit-level moderate`, which will fail builds on advisories with no fix yet); or promise nothing numeric
  beyond best effort.
- **Needs:** owner confirmation of the policy, since it is a public commitment.


### P8-94 — Copy name mismatch policy and threat model entry
- **Context:** `cf:setup --name X` kept `"name": "relic-bridge"` in `wrangler.X.local.jsonc`, so plain `wrangler -c` commands hit the production Worker.
- **Assumption made:** a new copy gets `"name": "<name>"`; an old copy still naming `relic-bridge` is rewritten once (with a note); a copy naming anything else, or a default-name run against a copy naming another Worker, is refused with the fix rather than rewritten. No THREAT_MODEL row: no existing threat matches an operator targeting the wrong Worker (T15 is token revocation), so none was added.
- **Options:** also rewrite any mismatched name (riskier: may overwrite a deliberate rename); add a new threat row for operator mistakes in deployment.
- **Needs:** owner choice on the new threat row. No changeset: only the private scripts and docs changed.

### P8-88 — Question-round path kept, refused instead of answered when it cannot ask (NEW-16)
- **Context:** a request that declares form elicitation only in its own `_meta` (the per-request capability path) but is
  not a 2026-07-28 request reaches the server with no way to send an MCP input request, because the server does not
  keep `initialize` (ADR-0005). It used to be refused with "handled as a question round" and a hint that told a caller
  who had already sent `confirm: true` to add it.
- **Assumption made:** keep the path (the write limit and the fuzz tests classify rounds from the raw body) and keep it
  fail closed: it is still refused with nothing sent, now with a truthful message, a hint that never mentions
  `confirm: true`, and the code `RB_WRITE_APPROVAL_UNAVAILABLE` when `RB_WRITE_APPROVAL=required`
  (`RB_INPUT_INVALID` otherwise). A 2026-07-28 client already gets the real input request.
- **Options:** (a) as made; (b) build the input request on the legacy path too (needs the SDK to carry a per-request
  capability on 2025-era connections, or a server-side session, which ADR-0005 rules out); (c) stop classifying a
  `_meta`-declared request as a question round (it would then be charged to the write limit and refused the same way).
- **Needs:** owner confirmation that (a) is enough, or a decision to pursue (b) after the MCP SDK exposes per-request
  capabilities on 2025-era connections.

### P8-88 — Span status for a refused write (P8-90 helper not landed)
- **Context:** P8-59 leaves the span status unset for caller errors. A write refused for lack of approval is classified
  as a caller error (`fault=caller`, no gRPC status code, so New Relic's service error rate is not moved by it), but the
  task asks the span to be marked as an error.
- **Assumption made:** a local rule in `telemetry.ts`: the two `RB_WRITE_APPROVAL_*` codes set span status ERROR while
  keeping `fault=caller` and no `rpc.grpc.status_code`. Replace with the P8-90 helper once it lands.
- **Needs:** none unless P8-90 chooses a different rule.

### P8-89 — Tracing check scope and the cost of trace_error
- **Context:** the task asks for an account-wide `count(*) FROM Span` when a trace has no spans, "one extra request at
  most". For an error group whose trace was found, the worst case is now the group lookup, the trace lookup, three trace
  queries and the check.
- **Assumption made:** the check uses the tool's time window and the whole account (not the entity), runs only when budget
  remains, and the declared cost grows from `1 + 4` to `1 + 5` NRQL units. When the check cannot run, the generic
  "sampled out" wording stays. The earlier entity-scoped check for an error group with no traced occurrence is unchanged.
  A total in the user impact report is `null` as soon as any front end's part is `null` (not a partial sum).
- **Needs:** none unless a partial sum with a note is preferred over `null`.
