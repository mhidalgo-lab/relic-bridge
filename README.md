# relic-bridge

> **Status: alpha (v0.1, local stdio only).** Hosted and multi-device modes are on the [roadmap](docs/ROADMAP.md).

[![CI](https://github.com/matiashidalgo/relic-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/matiashidalgo/relic-bridge/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/matiashidalgo/relic-bridge/badge)](https://scorecard.dev/viewer/?uri=github.com/matiashidalgo/relic-bridge)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents (Claude Code,
Claude Desktop, claude.ai, Claude mobile, Cursor, VS Code, …) query **New Relic** through the **NerdGraph** API using
only a **User API key** — no account-level MCP enablement required.

- **Runs anywhere:** local stdio (`npx`), self-hosted Node / Docker, or a Cloudflare Worker you can reach from every device.
- **Multiple projects:** each New Relic account/region/key gets its own URL (`/p/{slug}/mcp`).
- **Fine-grained access:** per-device tokens or OAuth, per-grant tool and account allowlists, bring-your-own-key for teams.
- **Secure by default:** read-only tools, encrypted keys, query limits, audit log, documented threat model.

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
  [configuration](docs/guide/configuration.md) · [security basics](docs/guide/security-basics.md) ·
  [troubleshooting](docs/guide/troubleshooting.md) · [tool reference](docs/reference/tools.md)
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
