# Self-hosting: the database

Self-hosted mode (Phase 2) keeps projects, encrypted credentials, grants, device tokens, the audit log and OAuth state
in one SQLite file. This page covers that file; the HTTP server, Docker, TLS and multi-device setup are added by the
rest of Phase 2 (P2-06, P2-11, P2-13).

stdio mode does not use a database: it reads `relic-bridge.yaml` or environment variables
([configuration](configuration.md)).

## The database file

- The adapter uses Node's built-in `node:sqlite` (Node 24.11 or newer). There is nothing to compile or install, on
  Linux, macOS or Windows.
- On first start the file is created with mode **`0600`** inside a directory with mode `0700`. If an existing file
  is readable by group or others it is tightened on open. On Windows, protect the folder with the normal user-profile
  permissions instead (POSIX modes don't apply).
- It runs in **WAL** mode, so you will also see `<file>-wal` and `<file>-shm` next to it while it is open. They are part
  of the database: copy or move all three together when the server is stopped, or use `db backup` (below) while it runs.
- Schema migrations are applied automatically on start and are **forward-only**. A database written by a newer
  relic-bridge is refused, so keep a backup before upgrading and don't downgrade.
- Put the file on a local disk. SQLite locking is unreliable on network file systems (NFS, SMB, some synced folders).

## Back it up

```bash
relic-bridge db backup ~/backups/relic-2026-10-03.db --db /var/lib/relic-bridge/relic.db
# or: RB_DB_PATH=/var/lib/relic-bridge/relic.db relic-bridge db backup <file>
```

The command writes a consistent snapshot (SQLite `VACUUM INTO`), including recent writes still in the WAL. It is safe to
run while the server is up, opens the source read-only (it never migrates or modifies it), creates the copy with mode
`0600`, and refuses to overwrite an existing file. Run it before every upgrade.

To restore, stop the server and put the backup file in place of the database (remove stale `-wal` / `-shm` files).

## Security: the database and the master key

New Relic keys are stored only as AES-256-GCM ciphertext, and device tokens only as SHA-256 hashes. **The database
together with the master key exposes every stored New Relic key.** Therefore:

- Never keep the master key in the same directory, volume, backup or repository as the database. Give it to the process
  through the environment or a secret store.
- Treat a backup exactly like the live file: it has the same contents. Encrypt backups at rest if they leave the host,
  and keep their permissions at `0600`.
- Don't commit `*.db`, `*.sqlite` or their `-wal` / `-shm` files (they are in `.gitignore`).
- If the file or a backup may have leaked, rotate the master key (`relic-bridge keys rotate`) and the New Relic keys
  stored in it.

Creating, storing, backing up and rotating the master key: [secrets](secrets.md). See also the
[threat model](../THREAT_MODEL.md) (T7).

## Re-checking stored New Relic keys

A New Relic key can be revoked or lose access to an account in New Relic at any time. Re-check every stored key
with:

```bash
relic-bridge credential revalidate --db /var/lib/relic-bridge/relic-bridge.db   # needs RB_MASTER_KEY
```

A key New Relic refuses is marked `invalid`, and every grant that uses it stops working (fail closed) until the key is
replaced or a later check passes. Valid keys get their reachable accounts refreshed, so an account the key lost is
dropped from every connection. Network errors and rate limits change nothing. The command exits `1` when any key is
invalid or could not be checked, so a daily cron job can alert you. How credentials, projects and grants combine:
[access model](access-model.md).
