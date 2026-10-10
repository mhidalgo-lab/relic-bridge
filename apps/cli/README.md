# relic-bridge

Unofficial [Model Context Protocol](https://modelcontextprotocol.io) server for **New Relic**: AI agents (Claude Code,
Claude Desktop, Cursor, VS Code, …) query your telemetry through the **NerdGraph** API with only a New Relic **User**
API key. Read-only tools, query limits, untrusted-data envelopes and secret redaction are on by default.

## Install and run

Requires Node.js 24.11 or later. The package is a local stdio MCP server that your MCP client starts. The same CLI also provides `relic-bridge serve`
(self-hosted HTTP server), management commands for projects, grants and device tokens, `doctor` diagnostics and OS
keychain storage for keys:

```sh
claude mcp add relic \
  --env NEW_RELIC_API_KEY=<your User key> \
  --env NEW_RELIC_ACCOUNT_ID=1234567 \
  --env NEW_RELIC_REGION=US \
  -- npx -y relic-bridge
```

JSON-config clients use `"command": "npx", "args": ["-y", "relic-bridge"]` with the same `env` block.

## Documentation

- [Local quickstart](https://github.com/mhidalgo-lab/relic-bridge/blob/main/docs/guide/quickstart-local.md)
- [Client setup](https://github.com/mhidalgo-lab/relic-bridge/blob/main/docs/guide/clients.md) ·
  [configuration](https://github.com/mhidalgo-lab/relic-bridge/blob/main/docs/guide/configuration.md) ·
  [security basics](https://github.com/mhidalgo-lab/relic-bridge/blob/main/docs/guide/security-basics.md) ·
  [tool reference](https://github.com/mhidalgo-lab/relic-bridge/blob/main/docs/reference/tools.md)
- [Changelog](https://github.com/mhidalgo-lab/relic-bridge/blob/main/apps/cli/CHANGELOG.md)

## Verifying a release

Every version is published from GitHub Actions with npm provenance (`npm audit signatures`). The GitHub Release for
each version carries the same tarball, a CycloneDX SBOM and `SHA256SUMS`, all with a GitHub build attestation
(`gh attestation verify relic-bridge-<version>.tgz --repo mhidalgo-lab/relic-bridge`).

## Disclaimer

relic-bridge is an unofficial, community project. It is not affiliated with, endorsed by, or supported by
New Relic, Inc. New Relic and NerdGraph are trademarks of New Relic, Inc.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
