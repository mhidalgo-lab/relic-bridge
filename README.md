# relic-bridge

> **Status: pre-alpha (Phase 0).** Nothing to install yet — see the [roadmap](docs/ROADMAP.md).

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
