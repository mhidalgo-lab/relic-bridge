# relic-bridge

> **Status: alpha.** v0.1 (local stdio) is the released line. The self-hosted multi-device server (Phase 2, v0.2), the
> Cloudflare Worker (Phase 3, v0.3) and the sign-in and admin panel (Phase 4, v0.4) are implemented on the development
> branches and documented here; none of them is released yet. OAuth (Phase 5, v0.5) is implemented and documented for
> claude.ai and Claude mobile, but has **not** been verified with the real apps ([compatibility](docs/reference/client-compatibility.md)).

[![CI](https://github.com/mhidalgo-lab/relic-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/mhidalgo-lab/relic-bridge/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mhidalgo-lab/relic-bridge/badge)](https://scorecard.dev/viewer/?uri=github.com/mhidalgo-lab/relic-bridge)
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

**Implemented for v0.3 (Cloudflare; not released yet):**

- A Cloudflare Worker deployment on D1, one setup command or a Deploy button
  ([guide](docs/guide/cloudflare-deploy.md), [limits and costs](docs/guide/cloudflare-limits.md)). The guide has not yet
  been validated on a clean Cloudflare account.

**Implemented for v0.4 (sign-in and admin panel; not released yet, [admin guide](docs/guide/admin-guide.md)):**

- **Sign in** with Google, GitHub, Cloudflare Access or any OpenID Connect provider, with deny-by-default allow-lists,
  optional auto-provisioning, and a one-time setup link for the first owner ([identity providers](docs/guide/identity-providers.md)).
- **Sessions, roles and CSRF** (owner, admin, member) for the admin API and the panel ([admin access](docs/guide/admin-access.md)).
- An **admin panel** (`/admin`, works on a phone, no JavaScript needed): New Relic keys, projects, grants, device tokens,
  users, an audit viewer with CSV export, usage statistics, a connect page with client snippets, and "My access" for
  members, who bring their own keys ([panel guide](docs/guide/admin-panel.md)).
- Contributor checks: a Playwright browser run (`pnpm test:e2e`) and an OWASP ZAP baseline scan (`pnpm scan:zap`).

**Implemented for v0.5 (OAuth for claude.ai and your phone; not released yet, [phone guide](docs/guide/oauth-phone.md)):**

- **OAuth 2.1** (`RB_OAUTH=on`): claude.ai on the web and the Claude mobile apps connect to `/p/{slug}/mcp` without a
  token. Discovery, client metadata documents and dynamic registration, a consent screen where you choose the grant,
  one-hour access tokens with rotating refresh tokens, and per-device **Disconnect** plus an owner's OAuth apps list
  ([OAuth guide](docs/guide/oauth.md), [how it works](docs/guide/oauth-how-it-works.md)).
- The split for several devices: laptops use a device token each, the phone uses OAuth.
- Tested with SDK clients shaped like the real ones; the real claude.ai and mobile apps are still to be checked
  ([client compatibility](docs/reference/client-compatibility.md)).

**In review, not released** (see the [roadmap](docs/ROADMAP.md)):

- Phases 6 (more tools) and 7 (power features: write tools, Tasks, doctor, config import/export, OS keychain, quotas,
  OTLP export, the Claude Code plugin) are built and in review as stacked PRs; they are not released yet.

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
published from GitHub Actions with npm provenance; each [GitHub Release](https://github.com/mhidalgo-lab/relic-bridge/releases)
carries the tarball, an SBOM and checksums with build attestations. Changes: [CHANGELOG](apps/cli/CHANGELOG.md).

## Documentation

- **Guides:** [local quickstart](docs/guide/quickstart-local.md) · [client setup](docs/guide/clients.md) ·
  [self-hosting](docs/guide/self-hosting.md) · [deploy to Cloudflare](docs/guide/cloudflare-deploy.md) · [Cloudflare limits and costs](docs/guide/cloudflare-limits.md) · [multi-device setup](docs/guide/multi-device.md) · [admin guide](docs/guide/admin-guide.md) ·
  [admin panel](docs/guide/admin-panel.md) · [sign-in providers](docs/guide/identity-providers.md) · [use it from your phone and claude.ai](docs/guide/oauth-phone.md) · [OAuth settings](docs/guide/oauth.md) · [how OAuth works](docs/guide/oauth-how-it-works.md) · [client compatibility](docs/reference/client-compatibility.md) · [admin access](docs/guide/admin-access.md) ·
  [access model](docs/guide/access-model.md) · [secrets](docs/guide/secrets.md) ·
  [configuration](docs/guide/configuration.md) · [charts (MCP Apps)](docs/guide/charts.md) · [security basics](docs/guide/security-basics.md) ·
  [troubleshooting](docs/guide/troubleshooting.md) · [registry listing](docs/guide/registry-listing.md) · [tool reference](docs/reference/tools.md) · [CLI reference](docs/reference/cli.md)
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
