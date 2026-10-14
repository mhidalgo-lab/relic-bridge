# Versioning, support and deprecation policy

What a relic-bridge version number promises, how long a deprecated field or setting keeps working, which versions get
security fixes, and what you can rely on when you upgrade. How to upgrade, step by step and version by version:
[upgrading](upgrading.md).

## Version numbers

relic-bridge follows [Semantic Versioning](https://semver.org/). One version number covers everything released
together: the `relic-bridge` npm package (CLI, stdio server, `serve`), the container image
(`ghcr.io/mhidalgo-lab/relic-bridge:<version>`) and the Worker built from the matching `v<version>` git tag. The first
published release is **0.7.0**; 0.1.0 to 0.6.x were never published. Every change is listed in the
[CHANGELOG](../../apps/cli/CHANGELOG.md) and on the GitHub Release.

| Release | Before 1.0 (`0.y.z`) | From 1.0 (`x.y.z`) |
|---|---|---|
| Patch (`z`) | Bug and security fixes only. Never breaking, never a database migration, never removes or renames anything. | Same. |
| Minor (`y`) | New features, deprecations and, when needed, **breaking changes**, each marked **Breaking** in the release notes with what to do. | New features and deprecations. Never breaking. |
| Major (`x`) | — | Breaking changes, including removal of what was deprecated. |

Before 1.0 a breaking change still needs a reason, and it goes through a deprecation period whenever keeping the old
form is cheap (a renamed field, argument or variable keeps working as an alias; see [Deprecations](#deprecations)).
The 0.9.0 rename of `whoami.limits.callBudget` without an alias was a slip under this rule: 0.9.1 restored the old
name as a deprecated alias.

**One exception, both before and after 1.0: security.** A fix for a vulnerability may tighten a default, refuse
input that used to be accepted, or remove a field that leaks data, in a patch release and without a deprecation
period. The release notes and the security advisory say so.

## What counts as a breaking change

The contract is what scripts, grants and clients depend on. Wording meant for people and models is not.

| Surface | Compatible (minor; a fix may be a patch) | Breaking |
|---|---|---|
| **Tool names** | A new tool. | Removing or renaming a tool (grants, `RB_TOOLS` and `tools:` lists name tools). Turning a read-only tool into one that writes. |
| **Tool input schemas** | A new optional argument. A wider range or a new enum value. A clearer error. | Removing or renaming an argument (unknown arguments are refused, so old callers fail), a new required argument, a narrower range or fewer accepted values, a default that changes what is returned. |
| **Tool output (`structuredContent`)** | A new field. A new value of an output enum or status (listed in the release notes). A field that used to fail validation now accepted in more shapes, when the old shape made the call fail. | Removing or renaming a field, changing its type, units or meaning, making a never-null field nullable. |
| **Descriptions and text content** | Any change, in any release. Text is written for models and people; scripts should read `structuredContent`. | Not a contract. |
| **Error codes** (`RB_*`) | A new code, a better message. | Removing or renaming a code, or reusing it for another condition. |
| **Prompts and resources** | Same rules as tools (names and arguments). | Same rules as tools. |
| **CLI** (`relic-bridge` commands, flags, exit codes) | A new command or flag. | Removing or renaming one, a different meaning or exit code. Human-readable output is not a contract unless documented as one. |
| **Configuration** (env vars, YAML keys, `wrangler` vars) | A new variable or key with a default that keeps today's behaviour. | Removing or renaming one (unknown YAML keys and invalid values stop startup), a default that changes behaviour. A stricter default for security follows the security exception. |
| **Query limits and access model** | A new opt-in limit. | A limit that refuses queries it accepted before (0.8.0 made `maxWindowDays` also bound the lookback: a breaking minor before 1.0). |
| **Admin API** (`/api/admin/v1`) | A new endpoint, a new optional request field, a new response field. Request bodies still refuse fields the server does not know, so send new fields only to servers that have them. | Removing or renaming an endpoint or field, a new required field, a different status code. This needs a new base path (`/api/admin/v2`); `v1` keeps working for the deprecation period. |
| **Storage schema** (SQLite, D1) | A new migration in a minor. It runs automatically on start and keeps every row. | Never in a patch. A database from any published release since 0.7.0 must upgrade to the current schema (tested, see below); a migration that drops data needs a deprecation first. Downgrades are not supported. |
| **Config export file** (`config export`) | New optional sections. | A file an older release wrote that the new one cannot import. |
| **Runtimes** | Support for a new Node.js line, MCP protocol revision or Workers compatibility date. | Dropping a Node.js line before its end of life, or an MCP protocol revision. Dropping an end-of-life Node.js line is allowed in a minor. |

### Clients keep the tool list they connected with

Over HTTP (`serve`, Docker, the Worker) relic-bridge is stateless and advertises `tools.listChanged: false`, so it
cannot tell a connected client that tools changed. After an upgrade a client still holds the old `tools/list`: it does
not see new tools or arguments until it reconnects. A stdio server is a process the client starts, so the new version
runs, and its tool list is read, only once the client restarts it. Since 0.9.0 the advertised output schemas accept fields they do not list, so a client
that connected before an upgrade does not reject results that gained fields. **Reconnect your MCP clients after
every upgrade** ([troubleshooting](troubleshooting.md)).

## Deprecations

A deprecated field, argument, setting or endpoint keeps working, unchanged, until it is removed.

**Window.** Before 1.0, something deprecated in `0.y` keeps working through all of `0.(y+1)` and is removed in
`0.(y+2).0` at the earliest ("the minor after next"). From 1.0 it keeps working until the next major, and for at least
six months after the deprecation was released.

**How a deprecation is announced** (all that apply):

1. The release notes: a changeset line that starts with `Deprecated:`, naming the replacement and the release that
   removes it.
2. In a tool schema: the field or argument description starts with `Deprecated:` and names the replacement and the
   removal release. New deprecations also set JSON Schema `deprecated: true` (zod `.meta({ deprecated: true })`).
3. A deprecated tool says so at the start of its description.
4. A deprecated environment variable or YAML key: announced in the release notes and the [upgrade notes](upgrading.md)
   (items 1 and 6). A startup warning on stderr and a `relic-bridge doctor` check for deprecated configuration are
   planned (P8-67); until they ship, the changelog and the upgrade guide are the only announcement for configuration.
5. A deprecated admin API field or endpoint: `deprecated: true` in the OpenAPI document and the
   [reference](../reference/admin-api.md).
6. The table below and the [upgrade notes](upgrading.md).

**Removal** happens in the announced release, with a changeset marked **Breaking** that says
"Removed (deprecated in `<version>`)" and what to use instead.

### Current deprecations

| What | Deprecated in | Use instead | Removed in | Removal task |
|---|---|---|---|---|
| `whoami` output `limits.callBudget` | 0.9.1 | `limits.perCallBudget` (same value) | 0.11.0 | [P8-62](../tasks/phase-8-hardening-launch/P8-62-remove-callbudget-alias.md) (starts after 0.10.0 is published) |

## Supported versions and security fixes

| Version | Bug fixes | Security fixes |
|---|---|---|
| Before 1.0 (`0.x`) | Latest minor only. | Latest minor only, as a patch release. No backports: upgrade to the latest minor. |
| From 1.0 | Latest minor only. | Latest minor, and the previous minor for 3 months after a new minor is released. |

A security fix lands on `main` first and ships as a patch of the latest minor. Where a backport is supported it ships
as a patch of the older minor at the same time. Backports will be cut from `release/x.y` branches; that release path
is planned (P8-68) and does not exist yet, which is moot until 1.0 because nothing is backported before then. Reports and timelines: [SECURITY.md](../../SECURITY.md). Advisories are
published as GitHub Security Advisories and linked from the release notes.

relic-bridge supports the Node.js lines in `engines` (currently 24.11 or newer; CI runs 24 and 26) and the MCP
protocol revisions the [client compatibility](../reference/client-compatibility.md) page lists.

## Database upgrades are tested

Every published minor has a database fixture (`packages/storage/test/fixtures/db/v<minor>.json`). Each one is
generated by `scripts/gen-db-fixtures.ts` from the migrations embedded in that release's git tag, applied to an empty
database with a fixed set of synthetic rows (no real keys, tokens or accounts), so it is the database a user of that
release has. The tests open each fixture with the current build, on SQLite (`packages/storage-sqlite`) and on D1 in
workerd (`apps/worker`), and check that it reaches the current schema, that the schema equals a fresh database, that
every row reads back, and that writes still work. `pnpm lint` checks that the fixtures match their migrations and,
when the release tags are present, that every published minor has one and that no patch release changed migrations.

## For contributors

- A changeset for every user-visible change. Before 1.0, a breaking change is a `minor` changeset whose text starts
  with `**Breaking**:` and says what to do; from 1.0 it is a `major` changeset.
- Deprecating: keep the old form working, mark it as above, add it to [Current deprecations](#current-deprecations)
  and to the [upgrade notes](upgrading.md), and open a task for the removal with "start after `<version>` is
  published".
- Renames follow [tool conventions](../dev/tool-conventions.md); a rename of something released is a deprecation.
- A migration only in a minor. After the release that adds one, run `pnpm db:fixtures` (needs the release tags,
  `git fetch --tags`) and commit the new fixture.
