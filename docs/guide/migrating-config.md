# Move your configuration: export and import

`relic-bridge config export` and `config import` copy users, projects, grants and settings between a local database,
Docker and a Cloudflare Worker, so you do not retype them. Both are **owner-only** Admin API calls (the admin token, or
an owner session), work locally and with `--remote`, and are recorded in the audit log (`config.export`,
`config.import`).

## What moves, and what never does

| Moves | Never moves |
|---|---|
| Users (email, display name, role) | Access tokens (create new ones with `token create`) |
| New Relic key **metadata** (label, region, owner) | Plaintext New Relic keys (see below) |
| Projects (accounts, tools, limits, default key, disabled) | OAuth clients, devices, sessions, admin sessions |
| Grants (project, user or service label, key, tools, accounts, limits, rate limit, expiry) | Sign-in identity bindings (`idp`, subject): people bind again on first sign-in |
| The `oauth.registration` setting | Master keys, key check values, the audit log |

Revoked grants and keys, disabled users and expired grants are left out.

## Export

```sh
# 1. Structure only. The file holds no secret at all.
relic-bridge config export --out relic-bridge-config.yaml

# 2. With the New Relic keys, encrypted under a passphrase you choose (12+ characters).
relic-bridge config export --out relic-bridge-config.yaml --with-credentials          # hidden prompt, asked twice
relic-bridge config export --out cfg.yaml --with-credentials --passphrase-file ~/.rb-pass   # file with mode 0600
relic-bridge config export --out cfg.yaml --with-credentials --passphrase-env RB_PASS       # the variable's name
```

Against a deployed server add `--remote https://your-server` (the admin token comes from `RB_ADMIN_TOKEN`).
Locally, `--with-credentials` needs the master key (`RB_MASTER_KEY` or `RB_MASTER_KEY_FILE`) to read the stored keys.

**Whose keys are included.** Shared keys, and personal keys of the person who runs the export (an owner session). The
admin token and the CLI are nobody, so they export shared keys only; another person's personal key is listed (label,
region, owner) but never leaves the server, because the API never reveals a stored key and an export must not become a
way to take a colleague's. The export warns about each one left behind; that person adds it again on the target
(`credential add --owner`, or **My keys** in the admin panel) and imports again.

The file is created exclusively with mode `0600`; the command refuses to overwrite an existing file. The passphrase is
never an option value (it would land in your shell history and process list).

**How the keys are protected.** The CLI derives a 256-bit key from your passphrase with PBKDF2-HMAC-SHA-256 (600 000
iterations, random 16-byte salt) and sends only that derived key to the server, which seals each New Relic key with
AES-256-GCM. The server never sees the passphrase, never returns a plaintext key, and a Worker does no expensive key
derivation (Workers cap PBKDF2 at 100 000 iterations). The labels, regions and owners of the keys are bound to the
ciphertext: changing them in the file makes decryption fail. Everything else in the file can be edited by hand. Scrypt and
Argon2 are not available in WebCrypto, so PBKDF2 with the OWASP-recommended iteration count is used; the format is
versioned (`version: 1`, `secrets.kdf`) so a stronger scheme can follow.

Treat the file like a password vault: anyone with the file and a guessable passphrase can read your New Relic keys.
Use a long random passphrase and keep it apart from the file.

## Import

```sh
relic-bridge config import relic-bridge-config.yaml                       # dry run: prints the plan, changes nothing
relic-bridge config import relic-bridge-config.yaml --apply               # makes the changes
relic-bridge --remote https://rb.example.com config import cfg.yaml --apply --passphrase-env RB_PASS
```

A dry run prints one line per change (`create`, `update`, `skip` with the reason) and a summary, then exits `0`. Review
it, then add `--apply`. If the file holds encrypted keys, the passphrase is asked for (or read from
`--passphrase-file` / `--passphrase-env`); an empty answer imports everything except the keys.

Rules the import follows:

- **Strict.** Unknown fields, wrong types, more than 200 users, 100 keys, 100 projects or 500 grants, duplicates,
  references that do not resolve inside the file and tool names this server does not have are all refused before
  anything changes. The Admin API body limit (64 KiB by default) applies.
- **Idempotent.** Entities are matched by natural key (user email, key owner + label, project slug, grant project +
  user or service label). Importing the same file twice changes nothing the second time.
- **Additive.** It never deletes or revokes anything. **Users** are created, never modified, and are never created as
  `owner` (an `owner` in the file becomes `admin`; use `user add --role owner`). **Projects** are created or updated
  where they differ; the plan lists the changed fields, including any widening of accounts or tools. **Grants** are
  created; a grant that exists with other settings is skipped (change it with the grant commands). **Keys** that already
  exist keep their stored secret.
- **Validated.** A new key is checked against New Relic and encrypted under the target's master key, exactly like
  `credential add`. A key that cannot be added (no key in the file, New Relic refuses it) is skipped, and so are the
  grants that need it; add it with `credential add`, then import again.
- **Not transactional.** `--apply` stops at the first failure, says where, and exits `1`. Everything before it was
  applied; fix the cause and run the same import again to resume. On the Workers Free plan one request may make at most
  50 D1 queries, so a large import can stop with `503 unavailable` part-way: run it again until it reports nothing left
  to create.
- **Personal keys as defaults.** If a project's default key is someone's personal key, it becomes the project default
  (shared with everyone on the project) and the plan warns about it. Check that is what you want before `--apply`.

After importing, create device tokens on the target (`relic-bridge token create --grant <id> --label <device>`), have
people sign in once to bind their identity, and run `relic-bridge doctor --remote <url>`.

## Typical moves

- **Laptop to a Worker.** `config export --with-credentials` locally, then `config import --apply --remote
  https://<worker>`; then `token create` per device. See [Deploy to Cloudflare](cloudflare-deploy.md).
- **Local to Docker.** Same, with `--remote http://localhost:8787 --insecure` (or import locally with `--db` pointing at
  the volume).
- **Rebuilding a server.** Export before wiping; import into the fresh database (new master key is fine: keys are
  re-encrypted).

Related: [secrets](secrets.md), [admin API reference](../reference/admin-api.md), [CLI reference](../reference/cli.md).
