# Architecture Decision Records

Format: [MADR](https://adr.github.io/madr/)-lite. One file per decision, numbered and never renumbered. To change a
decision, add a new ADR that **supersedes** the old one; don't rewrite history.

Statuses: `proposed` · `accepted` · `accepted (pending spike PX-NN)` · `superseded by NNNN` · `rejected`.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-markdown-planning.md) | Markdown files for decisions and tasks | accepted |
| [0002](0002-name-and-trademark.md) | Project name `relic-bridge` and trademark posture | accepted |
| [0003](0003-license-apache-2.md) | Apache-2.0 license with DCO | accepted |
| [0004](0004-typescript-runtime-agnostic-core.md) | TypeScript monorepo, runtime-agnostic core, Hono | accepted |
| [0005](0005-mcp-sdk-v2-stateless.md) | MCP SDK v2, stateless, dual protocol era | accepted (spike P0-07) |
| [0006](0006-storage-sqlite-d1.md) | SQLite schema for D1 and Node, YAML for stdio | accepted |
| [0007](0007-secrets-envelope-encryption.md) | AES-256-GCM encryption of NR keys | accepted |
| [0008](0008-access-model.md) | Credentials, projects, grants, tokens | accepted |
| [0009](0009-authentication.md) | Bearer tokens first, OAuth 2.1 next; Google, GitHub, Cloudflare Access | accepted (spike P0-08) |
| [0010](0010-platform-limits-strategy.md) | Budgets, concurrency and retries for Workers and NerdGraph limits | accepted (spike P0-06) |
| [0011](0011-oauth-state-in-storage-kv.md) | OAuth provider state in the storage `kv` table on both runtimes | accepted (P5-01) |
| [0012](0012-cimd-resolved-by-relic-bridge.md) | Client ID Metadata Documents resolved by relic-bridge, per-runtime SSRF guard | accepted (P5-03) |
| [0013](0013-refresh-token-reuse-interval.md) | Refresh token reuse interval for concurrent refreshes | accepted (P5-09, owner confirmation pending) |
| [0014](0014-no-raw-nerdgraph-tool.md) | No raw NerdGraph passthrough tool | accepted (P6-15, owner confirmation pending) |
| [0015](0015-opt-in-write-tools.md) | Opt-in write tools: three typed writes, off at every layer | accepted (P7-09, owner confirmation pending) |
