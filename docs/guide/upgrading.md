# Upgrading relic-bridge

How to move to a newer release safely, and what changed between the published releases. What a version number
promises, and how long deprecated things keep working: [versioning policy](versioning.md).

## Before you upgrade

1. **Read the release notes** of every version between yours and the target ([CHANGELOG](../../apps/cli/CHANGELOG.md),
   GitHub Releases), and the [notes below](#version-notes). Look for **Breaking** and `Deprecated:` lines.
2. **Back up the database** (`serve`, Docker, Worker): it is the only state, and migrations are forward-only.
   - SQLite: `relic-bridge db backup <new-file> --db <your db>` (safe while the server runs;
     [self-hosting](self-hosting.md#back-it-up)).
   - D1: note the time (D1 Time Travel can restore any point of the last 7 or 30 days) or export the database
     ([Cloudflare guide](cloudflare-deploy.md#backups-and-the-master-key)).
   - Keep the master key where it already is, separate from the backup ([secrets](secrets.md)).
3. **Check the runtime**: Node.js 24.11 or newer for the npm package.

You can skip versions. Migrations run in order on start, and any database from a published release since 0.7.0
upgrades directly to the current one (tested for every published minor, see
[versioning](versioning.md#database-upgrades-are-tested)). Deprecation windows assume you read the notes of the
releases you skip.

## Upgrade

| Mode | Steps |
|---|---|
| Local stdio (`npx relic-bridge`) | Pin the version in the client config (`npx -y relic-bridge@<version>`) or update the global install (`npm install -g relic-bridge@<version>`), then restart the MCP client so it starts the new process. |
| `serve` from npm | `npm install -g relic-bridge@<version>`, restart the service. Migrations run on start. |
| Docker | Change the image tag (`ghcr.io/mhidalgo-lab/relic-bridge:<version>`, verify it as in [verify a release](verify-release.md)), recreate the container. Migrations run on start. |
| Cloudflare Worker | `git fetch --tags && git checkout v<version>`, `pnpm install`, `pnpm cf:setup --plan <your plan>` ([updating](cloudflare-deploy.md#updating)). The first request into a new isolate applies pending D1 migrations. |

Then:

- **Reconnect every MCP client** (Claude Code: `/mcp`; remove and re-add the connector, or restart the app,
  elsewhere). A client keeps the tool list it fetched before the upgrade, so new tools and arguments stay invisible
  until it reconnects ([troubleshooting](troubleshooting.md)).
- Run `relic-bridge doctor` (local) or call `whoami` from a client to check keys, accounts and limits.

## Rolling back

- **Same schema**: going back to the previous release works when no migration was added in between (the release
  notes say when one is). Deploy the older version; the database is unchanged.
- **After a migration**: an older build refuses a database a newer one migrated ("newer than this build"; on the
  Worker the isolate answers `503`). Restore the backup you took before upgrading (D1: Time Travel to a moment
  before the upgrade), then deploy the older version.
  Rows written since the upgrade are lost, so roll forward with a fix when you can.
- Published releases 0.7.0 to 0.9.1 all have the same schema (version 4), so rolling back between them is safe.

## Version notes

Only what needs action or changes what a script sees. Everything else is in the CHANGELOG.

### 0.10.x → 0.11.0

- **Breaking**: removed `whoami` `limits.callBudget` (deprecated in 0.9.1, announced for removal in 0.11.0); read
  `limits.perCallBudget`, which has the same value. Reconnect your MCP client after upgrading.

### 0.9.0 → 0.9.1

- `whoami` returns `limits.callBudget` again, as a **deprecated alias** of `limits.perCallBudget` (same value). It is
  removed in **0.11.0**: switch to `perCallBudget`. `callsUsed` and `callsRemaining` stay removed.
- `run_nrql` with both `FACET` and `TIMESERIES`: `totalResult` and `otherResult` can be an array of time buckets (the
  call used to fail output validation). Scripts reading them should accept an object or an array.
- `get_attributes`: `totalAttributes` is the count before `name_contains` and the cap; `truncated` means the filtered
  list was cut.
- `list_recent_issues` can return `groupsNote` and `limitNote`; `trace_error` notes give the count of errors with a
  trace id.
- Self-monitoring (OpenTelemetry): spans are named `tools/call <tool>`, the `rpc.server.duration` metric is exported and
  access-log records carry `status`, `method` and `route`. Update dashboards or alerts that matched the old span names.
- No database migration.

### 0.8.0 → 0.9.0

- **Breaking**: `whoami.limits.callBudget` was renamed `perCallBudget`, and `callsUsed` / `callsRemaining` were
  removed (the budget is per tool call, not a running total). 0.9.1 restored `callBudget` as an alias; upgrade to
  0.9.1 or later rather than 0.9.0.
- **Breaking**: `partial` now means an involuntary cut only. Metrics or dependencies left out by your own `max_metrics`
  / `max_dependencies` are listed in `skipped` with a `reason` and no longer set `partial: true`.
- `list_event_types` lists global event types only in `globalEventTypes` (no longer also in `eventTypes`).
- `list_top_transactions` with `sort_by: slowest` skips transactions with fewer than `min_requests` (default 10).
- `list_recent_issues` with `group_by` counts the whole window; the new `groupsScope` says `window` or `page`.
- Output schemas accept fields they do not list. Reconnect clients once after this upgrade; later output additions no
  longer break clients that connected before an upgrade.
- No database migration.

### 0.7.0 → 0.8.0

- **Breaking**: `maxWindowDays` also limits how far back a query reads (`SINCE 60 days ago UNTIL 59 days ago` is
  refused with `RB_LIMIT_QUERY` under a 7-day limit), in `run_nrql` and every tool with a time window. Raise
  `maxWindowDays` on the project or grant if you relied on older data.
- `run_nrql` refuses several `;`-separated statements ("one NRQL statement per call"); `get_query_result` with an
  unknown or expired id fails with `RB_QUERY_NOT_FOUND`.
- Name lookups take optional `domain` and `type` (for example `domain: "APM"`); an ambiguity error suggests them.
- `analyze_transactions` and `analyze_deployment_impact` take an optional `baseline` and decide with |z| >= 3 rules;
  verdicts can differ from 0.7.0 on the same data.
- `whoami` gained fields. A client that connected to 0.7.0 rejected the new output ("must NOT have additional
  properties") until it reconnected; reconnect after upgrading.
- No database migration.

### Upgrading to 0.7.0

0.7.0 is the first published release. Unreleased builds from before it are not covered by this policy or the upgrade
tests. Back up, then start 0.7.0 or later on the database; if it refuses it, start with a new database and move users,
projects and grants with [config export and import](migrating-config.md).
