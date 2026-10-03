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
| `RB_MASTER_KEY_FILE` | Path to a file holding it instead (Node only). Refused when group or others can read it. |
| `RB_MASTER_KEY_PREVIOUS` / `RB_MASTER_KEY_PREVIOUS_FILE` | The previous key, only while rotating. |

On Cloudflare, store it with `wrangler secret put RB_MASTER_KEY`. Never put it in `wrangler.toml`, a config file, a
Docker image, the same volume as the database, or a repository. There is no command-line flag for it on purpose.

The HTTP server (`relic-bridge serve`, landing later in v0.2) refuses to start without a valid key (missing, wrong
length, not base64, or a placeholder such as all zeros). It and `keys rotate` also remember a one-way **key check
value** for each key version in the database, so starting with a different key under an existing version number fails
at once (`key_mismatch`) instead of failing on every request.

## Rotate the key

Rotate after a suspected leak of the key or of a database backup, when someone with access leaves, or on a schedule.

1. Generate the next version, one above the current:
   ```bash
   relic-bridge keys generate --key-version 2 > rb-master-v2.key
   ```
2. Give the server **both** keys and restart it: `RB_MASTER_KEY=<v2>` and `RB_MASTER_KEY_PREVIOUS=<v1>`. It now
   encrypts new credentials with v2 and can still read rows that use v1.
3. Re-encrypt every stored key under v2 (same two variables, plus the database):
   ```bash
   relic-bridge keys rotate --db /var/lib/relic-bridge/relic.db
   ```
   Each row is re-encrypted and written on its own, atomically, and only if it hasn't changed since it was read. If
   the command stops halfway, every row is still readable with the two keys: run it again and it continues where it
   stopped. It exits `0` once every credential is on v2 and lists any row it could not rotate.
4. Remove `RB_MASTER_KEY_PREVIOUS` and restart. Keep the old key in your backup until you have confirmed the server
   starts and serves requests without it, then destroy it, together with database backups taken before the rotation if
   the old key may have leaked (those backups are encrypted with it).

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
