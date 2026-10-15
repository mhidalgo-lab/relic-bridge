---
"relic-bridge": minor
---

Supported migration from a self-hosted server to the Cloudflare Worker. `relic-bridge db export <file> --format d1`
writes the server's SQLite database as a SQL file that `wrangler d1 execute <database> --remote --file <file>` imports
into the Worker's D1 database: device tokens, encrypted New Relic keys, projects, grants, settings and the audit log
(`--no-audit` leaves it out) move; sessions and OAuth connections do not. Nothing is decrypted, the file is created
with mode 0600 and never overwritten without `--force`, and the import refuses a D1 database that already has data.
`pnpm cf:setup --master-key-stdin` sets up the Worker with the server's existing master key instead of generating
one; that key is never printed or written to `--backup-file`. See "Migrate from a self-hosted server" in the
Cloudflare guide.
