# 0006 — SQLite schema for D1 and Node, YAML for stdio

- Status: accepted
- Date: 2026-10-01

## Decision
- One relational schema in **SQLite dialect**, managed with **Drizzle ORM** and SQL migrations committed to the repo.
- Adapters:
  - `d1`: Cloudflare D1 (which is SQLite)
  - `sqlite`: Node (`node:sqlite` if stable in the target LTS, otherwise `better-sqlite3`; decided in P2-02)
  - `yaml`: read-only, for stdio mode; keys referenced as `${ENV_VAR}` or keychain entries, never plaintext
    (plaintext is allowed with a loud warning)
- OAuth server state: KV on Workers. On Node, a KV-compatible table in SQLite (if the spike confirms the library is
  portable) or the Node OAuth server's own adapter.
- A `Storage` interface in `packages/storage` is the only way core and auth reach persistence.

## Consequences
- Identical migrations locally and on Cloudflare; easy backup (a single SQLite file / `wrangler d1 export`).
