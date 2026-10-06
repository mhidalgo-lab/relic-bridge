---
id: P7-11
title: "OS keychain for local credentials"
phase: 7
status: in-progress
priority: low
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-11 — OS keychain for local credentials

## Scope
Node-only, in `apps/cli` (ADR-0004). Opt-in: nothing changes unless a keychain reference is used.

- **Backend choice: shell out to the OS tool, no native module.** `keytar` is archived; `@napi-rs/keyring` is a native
  addon shipped as per-platform optional dependencies, which breaks the "one `dist/index.mjs` file" package (P1-15
  allows only that file, `NOTICE` and the manifest) and widens the supply chain of an `npx` install. The tools used:
  `security -i` (macOS), `secret-tool` (Linux libsecret, including WSL2 when a Secret Service runs there) and
  Windows PowerShell with `Windows.Security.Credentials.PasswordVault` (Windows). **Secrets travel on stdin only,
  never as process arguments.**
- Stored under service `relic-bridge`, account = a name (`[a-z0-9][a-z0-9._-]{0,63}`). Secrets are limited to
  `[A-Za-z0-9_+/=.~:-]` (New Relic keys, `v1:<base64>` master keys), which also keeps every quoting layer safe.
- **References:** YAML `apiKey: keychain:<name>` (stdio config); `RB_MASTER_KEY_KEYCHAIN=<name>` and
  `RB_MASTER_KEY_PREVIOUS_KEYCHAIN=<name>` for the master key. Setting both a keychain name and the direct/`_FILE`
  form is an error. An unavailable backend or a missing entry is a clear error with a fix; there is **no silent
  fallback** that would start the server with another key (the user chooses env/file by changing the config).
- **Commands:** `relic-bridge keychain set <name>` (key from a hidden prompt, stdin, `--key-file` or `--key-env`),
  `keychain delete <name>`, `keychain status`. There is no `get`: a stored secret is never printed.
  (This replaces the original `credential add --keychain`: `credential add` stores keys encrypted in the database or
  on a remote server, where a keychain entry would not exist.)
- **doctor (P7-05):** a `keychain` check reports the backend and whether it is usable, and each referenced entry
  (present or missing, never the value).
- **Docs:** local config guide, `docs/reference/cli.md`, `docs/guide/secrets.md`, THREAT_MODEL (T7), RESEARCH.

## Acceptance criteria
- [ ] macOS, Linux (libsecret) and Windows backends behind one interface; tests mock the process runner and never touch
      the real keychain; macOS and Windows scripts are unit-tested for their stdin/argv shape only (no such hosts in CI).
- [ ] Secrets are never in argv, logs, errors or `doctor` output (tests assert the spawn arguments).
- [ ] `apiKey: keychain:<name>` works in stdio YAML; `RB_MASTER_KEY(_PREVIOUS)_KEYCHAIN` works for local commands and `serve`.
- [ ] `keychain set|delete|status` commands, with `set` verifying by reading back.
- [ ] `doctor` reports keychain status.
- [ ] WSL2 behaviour documented (libsecret inside WSL; Windows credential store not bridged).
- [ ] `check-package` still passes: no new dependency, one bundled file.
- [ ] Threat model and docs updated.

## Security notes
T7 for local mode: a keychain entry is protected by the login session (macOS prompts per app on first read; libsecret
unlocks with the desktop session), unlike a `0600` file readable by any process of the user. Any process running as the
user can still call the same OS tool, so it is not a boundary against local malware.

## Docs to update
- Local config guide, secrets guide, CLI reference, THREAT_MODEL T7.

## Out of scope
- Bridging WSL to the Windows credential store; keychain support for the HTTP server's other secrets (admin token,
  IdP client secrets); a native-module backend; encrypted-file fallback.
