# Secrets: the master key

Self-hosted and Cloudflare deployments store New Relic User keys in the database, encrypted with a **master key** that
only you hold. stdio mode doesn't use one (keys come from the environment or the config file).

> **Back up the master key.** Without it nobody, including you, can decrypt the stored New Relic keys: every
> credential has to be entered again. Keep a copy somewhere other than the server and its database backups (a password
> manager or a second secret store).

## Create a key

```bash
relic-bridge keys generate > rb-master.key   # prints v1:<base64 of 32 random bytes>
chmod 600 rb-master.key
```

The key is printed once on stdout and stored nowhere. Give it to the server as:

| Variable | Meaning |
|---|---|
| `RB_MASTER_KEY` | The current master key, `v<n>:<base64>`. A bare base64 value is read as version 1. |
| `RB_MASTER_KEY_FILE` | Path to a file holding it instead (Node only). Refused when group or others can read it (Docker and Kubernetes mount secrets `0444`/`0644` by default: set the mode to `0400`/`0600` and make the file owned by the user that runs the server; for the Docker image that is uid `65532`, see [self-hosting](self-hosting.md#docker)). |
| `RB_MASTER_KEY_PREVIOUS` / `RB_MASTER_KEY_PREVIOUS_FILE` | The previous key, only while rotating. |

On Cloudflare, store it with `wrangler secret put RB_MASTER_KEY`. Never put it in `wrangler.toml`, a config file, a
Docker image, the same volume as the database, or a repository. There is no command-line flag for it on purpose.

The HTTP server (`relic-bridge serve`, [self-hosting](self-hosting.md)) refuses to start without a valid key (missing, wrong
length, not base64, or a placeholder such as all zeros). It and `keys rotate` also remember a one-way **key check
value** for each key version in the database, so starting with a different key under an existing version number fails
at once (`key_mismatch`) instead of failing on every request.
They also refuse to start with a key whose version is lower than one the database already uses
(`key_version_retired`: after a rotation, the old key must never encrypt new credentials), and a key that is already
registered under another version number (every version needs its own new key).

## Rotate the key

Rotate after a suspected leak of the key or of a database backup, when someone with access leaves, or on a schedule.

1. Generate the next version, one above the current:
   ```bash
   relic-bridge keys generate --key-version 2 > rb-master-v2.key
   ```
2. Give the server **both** keys and restart it: `RB_MASTER_KEY=<v2>` and `RB_MASTER_KEY_PREVIOUS=<v1>`. It now
   encrypts new credentials with v2 and can still read rows that use v1.
3. Re-encrypt every stored key under v2. On a server whose SQLite file you can reach (same two variables, plus the
   database):
   ```bash
   relic-bridge keys rotate --db /var/lib/relic-bridge/relic.db
   ```
   On a server you manage through the Admin API (a [Cloudflare Worker](cloudflare-deploy.md#rotate-the-master-key) on
   D1, or `serve` on another machine), let the server do it; it needs the admin token, not the master keys:
   ```bash
   RB_ADMIN_TOKEN=… relic-bridge keys rotate --remote https://relic-bridge.example.com
   ```
   This calls `POST /api/admin/v1/keys/rotate` until every row was visited, re-encrypting at most `--batch-size`
   (default 25, at most 100) rows per call so each call stays well inside a Worker's limits. A Worker on the Free plan
   lowers the ceiling to 40 (one call stays under D1's 50 queries per invocation): a larger `--batch-size` is reduced,
   not refused, and the command still loops until every row was visited.

   Either way each row is re-encrypted and written on its own, atomically, and only if it hasn't changed since it was
   read. If the command stops halfway, every row is still readable with the two keys: run it again and it continues
   where it stopped (a second run changes nothing). It exits `0` once every credential is on v2 and lists any row it
   could not rotate: `key_version_unknown` (the server does not have the key that row uses: check
   `RB_MASTER_KEY_PREVIOUS`), `conflict` (it changed meanwhile: run again) or `decrypt_failed` (a damaged row: replace
   the key with `credential rotate <id>`). Each `--remote` call is recorded in the audit log (`keys.rotate`).
4. Remove `RB_MASTER_KEY_PREVIOUS` and restart. Only do this once step 3 reported 0 rows not on v2: at every start the
   server logs a warning (`Stored credentials cannot be decrypted with the configured master keys (N under version 1)`)
   when rows still use a version it has no key for. If you see it, put the previous key back as
   `RB_MASTER_KEY_PREVIOUS` and run step 3 again; those credentials are unreadable until you do. Keep the old key in your backup until you have confirmed the server
   starts and serves requests without it, then destroy it, together with database backups taken before the rotation if
   the old key may have leaked (those backups are encrypted with it). With several server processes or Worker
   isolates, run `keys rotate` once more right before this step: a process that was still running with the old
   configuration during the rotation could have stored a new credential under v1.

Rotating the master key does not change the New Relic keys themselves. If the database *and* the master key may both
have leaked, also rotate the New Relic User keys in New Relic and update them here.

## How it works

- AES-256-GCM through WebCrypto (the same code on Node and Workers). Each encryption uses a fresh random 96-bit IV.
- The data key and the key check value are derived from the master key with HKDF-SHA-256 under separate labels. The
  raw master key is not kept in memory after start-up, and is never logged.
- The authenticated data binds each ciphertext to its credential id and key version, so a ciphertext copied onto
  another row, or relabelled with another version, does not decrypt.
- Decrypted keys exist only in memory for the duration of a request and are never returned by the admin API (only the
  last four characters).

Details: [ADR-0007](../adr/0007-secrets-envelope-encryption.md), [threat model](../THREAT_MODEL.md) T7.

## The admin token

`RB_ADMIN_TOKEN` (or `RB_ADMIN_TOKEN_FILE` on Node) opens the admin API. It is not a key for encryption, but on
Cloudflare it guards an internet-facing API, so it must be random:

```bash
relic-bridge admin-token generate      # or: openssl rand -base64 32
```

`serve` and the Worker refuse a token at start when it is shorter than 32 characters, has fewer than 8 distinct
characters, repeats a block (`abc123abc123…`), is mostly runs or steps (`abcdef…`, `aaaabbbb…`) or contains a
placeholder (`changeme`, `your-admin-token`, `example`, `password`). The error names the rule, never the value. A token
that passes but does not look generated (low estimated entropy, no digits, common words such as `admin` or `test`)
starts with a warning in the log. Change it by setting a new value and restarting (`wrangler secret put RB_ADMIN_TOKEN`
on Cloudflare); `cf:setup` generates one for you.
