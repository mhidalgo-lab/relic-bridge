---
id: P7-06
title: "Config import/export"
phase: 7
status: done
priority: low
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-06 — Config import/export

## Scope
Move a configuration between a local database, Docker and a Worker without retyping it.

**Bundle** (format `relic-bridge-config`, `version: 1`; YAML on disk, JSON on the wire; a JSON file is valid YAML):
`users` (email, display name, role), `credentials` (ref, label, region, owner email: metadata only), `projects` (slug,
accounts, tools, limits, default credential ref, disabled), `grants` (project slug, user email or service label,
credential ref, tools, accounts, limits, rate limit, expiry) and `settings` (allowlist: `oauth.registration`).
Never exported: access tokens, OAuth clients/devices/sessions, sign-in identity bindings (`idp`, `idpSubject`), master
keys, key check values, audit rows, revoked or disabled things.

**Secrets.** Default: no New Relic keys in the file. `--with-credentials` adds a `secrets` block: the keys sealed with
AES-256-GCM under a key derived from a passphrase (PBKDF2-HMAC-SHA-256, 600 000 iterations, 16-byte random salt;
versioned; the credential metadata is bound as AAD so labels/regions cannot be swapped). The KDF runs **in the CLI**: the
server receives only the derived 256-bit wrap key (never the passphrase) and never returns a plaintext key, so a Worker
does no heavy KDF (Workers cap PBKDF2 at 100 000 iterations and CPU time). Passphrase: hidden prompt (asked twice on
export) or `--passphrase-file <0600 file>` / `--passphrase-env <NAME>`; never an option value; at least 12 characters.

**Admin API** (owner only, admin token or owner session; audited as `config.export` / `config.import`):
`POST /config/export` → `{data: bundle}`; `POST /config/import` `{bundle, apply?, wrapKey?}` → plan (`create` /
`update` / `unchanged` / `skip` per entity, with reasons) and, with `apply: true`, the outcome. Dry run is the default.

**Import rules.** Strict schema (unknown fields refused), size and count caps, cross-references must resolve inside the
bundle, tool names must exist in this server's catalog. Matching is by natural key (user email, credential owner+label,
project slug, grant project+user/label), so a second import is a no-op. Import only creates and updates; it never
deletes or revokes. Users are create-only and never become `owner` (an `owner` in the file is created as `admin`);
existing grants are never modified (create-only); projects may be updated (shown in the diff, including widenings);
existing credentials keep their stored key. New credentials are validated against New Relic and encrypted under the
target's master key by the same service as `credential add`. Apply is not transactional: it stops at the first failure
and reports what was applied; re-running resumes.

**CLI:** `relic-bridge config export --out <file> [--with-credentials] [passphrase source]` (file created exclusively,
mode 0600) and `relic-bridge config import <file> [--apply] [passphrase source]` (works with `--remote` and locally).

## Acceptance criteria
- [x] Export never contains plaintext keys, tokens, sessions, OAuth state or key check values (tests grep the output).
- [x] Encrypted export round-trips; wrong passphrase and tampered metadata/ciphertext are refused; versioned format.
- [x] Import validates strictly (schema, caps, references, catalog); dry run is the default and changes nothing.
- [x] Idempotent: import twice = second run all `unchanged`; round trip local SQLite → a second (Worker-style, D1-like
      memory/D1 storage) deployment through the Admin API is tested.
- [x] Owner-only (admin and member sessions get 403, no change); audited; owner boundary respected (no owner creation).
- [x] CLI: export file mode 0600, refuses to overwrite, passphrase never an option value.
- [x] Authz matrix lists both routes; docs and THREAT_MODEL updated.

## Security notes
T7 (keys at rest/transit): the wrap key travels only over the admin TLS channel and is wiped after use; KDF cost is paid
on the client (offline, not hot path). New threat T29 (config bundle): see THREAT_MODEL.

## Docs to update
- Migration guide (`docs/guide/migrating-config.md`), CLI reference, Admin API reference (generated), THREAT_MODEL T29, authz matrix: done.

## Out of scope
- Deleting/pruning entities that are absent from the file; modifying existing grants; importing tokens; OS keychain
  (P7-11); age/scrypt (Argon2/scrypt are not in WebCrypto; PBKDF2 with 600k iterations is the web-standard option).
