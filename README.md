# relic-bridge

> **Status: alpha.** v0.1 (local stdio) is the released line. The self-hosted multi-device server (Phase 2, v0.2) is
> implemented on the development branches and documented here; it is not yet released. Cloudflare, OAuth (claude.ai web
> and mobile) and the admin panel are on the [roadmap](docs/ROADMAP.md).

[![CI](https://github.com/matiashidalgo/relic-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/matiashidalgo/relic-bridge/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/matiashidalgo/relic-bridge/badge)](https://scorecard.dev/viewer/?uri=github.com/matiashidalgo/relic-bridge)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents (Claude Code,
Claude Desktop, claude.ai, Claude mobile, Cursor, VS Code, …) query **New Relic** through the **NerdGraph** API using
only a **User API key** — no account-level MCP enablement required.

**Available in v0.1 (local stdio):**

- **Local stdio** (`npx`): your MCP client starts the server; one connection from env vars, or one project per
  process from a YAML file.
- **Secure by default:** read-only tools, query limits, redacted logs, documented [threat model](docs/THREAT_MODEL.md).
  The key is read from the environment (`${VAR}` references in YAML) and is never a tool argument.

**Implemented for v0.2 (self-hosted HTTP; not released yet, [multi-device guide](docs/guide/multi-device.md)):**

- `relic-bridge serve`: a Node / [Docker](docs/guide/self-hosting.md#docker) HTTP server (SQLite) that your devices
  reach over TLS, with several projects at their own URLs (`/p/{slug}/mcp`).
- **One token per device** (`rb_live_…`), revocable individually; per-grant tool and account allowlists, query limits,
  rate limits and expiry ([access model](docs/guide/access-model.md)).
- New Relic keys stored **encrypted** (master key you hold, with rotation); bring-your-own-key for teams; an
  [audit log](docs/guide/audit-log.md) (90 days by default).
- A [management CLI](docs/reference/cli.md) and an [admin API](docs/reference/admin-api.md), plus an optional
  [pass-through mode](docs/guide/self-hosting.md#pass-through-mode) where callers bring their own key.

**Planned** (see the [roadmap](docs/ROADMAP.md); none of this exists yet):

- A Cloudflare Worker deployment.
- OAuth 2.1, which claude.ai on the web and Claude on your phone need (static tokens work in Claude Code, Cursor and
  VS Code on your computers today).
- Sign-in (Google, GitHub, Cloudflare Access) and an admin panel.

## Install

Node.js 24.11 or later and a New Relic **User** API key. relic-bridge v0.1 is a local stdio server that your MCP
client starts:

```sh
claude mcp add relic \
  --env NEW_RELIC_API_KEY=<your User key> \
  --env NEW_RELIC_ACCOUNT_ID=1234567 \
  --env NEW_RELIC_REGION=US \
  -- npx -y relic-bridge
```

> Until v0.1.0 is on npm (the release is prepared, not yet published), `npx -y relic-bridge` fetches a placeholder:
> build from a clone as the [quickstart](docs/guide/quickstart-local.md) explains.

Other clients and the multi-project YAML mode: [local quickstart](docs/guide/quickstart-local.md). Releases are
published from GitHub Actions with npm provenance; each [GitHub Release](https://github.com/matiashidalgo/relic-bridge/releases)
carries the tarball, an SBOM and checksums with build attestations. Changes: [CHANGELOG](apps/cli/CHANGELOG.md).

## Documentation

- **Guides:** [local quickstart](docs/guide/quickstart-local.md) · [client setup](docs/guide/clients.md) ·
  [self-hosting](docs/guide/self-hosting.md) · [multi-device setup](docs/guide/multi-device.md) ·
  [access model](docs/guide/access-model.md) · [secrets](docs/guide/secrets.md) ·
  [configuration](docs/guide/configuration.md) · [security basics](docs/guide/security-basics.md) ·
  [troubleshooting](docs/guide/troubleshooting.md) · [tool reference](docs/reference/tools.md) · [CLI reference](docs/reference/cli.md)
- [Roadmap & task index](docs/ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md) · [Decisions (ADRs)](docs/adr/) · [Research & platform limits](docs/RESEARCH.md)
- [Threat model](docs/THREAT_MODEL.md)
- [How we track work](docs/tasks/README.md) · [Agent instructions](AGENTS.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Development

```sh
corepack enable && pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Disclaimer

relic-bridge is an unofficial, community project. It is not affiliated with, endorsed by, or supported by
New Relic, Inc. New Relic and NerdGraph are trademarks of New Relic, Inc.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
