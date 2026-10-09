# 0016 — Human write approval required by default

- Status: accepted (owner decision 2026-10-09, pending-decisions phase 7 "Review — write approvals (H2)"); supersedes
  the default value in ADR-0015's P7-25 addendum (`RB_WRITE_APPROVAL` default `client`); the rest of ADR-0015 stands
- Date: 2026-10-09
- Related: THREAT_MODEL T6, T31; ADR-0015

## Context
ADR-0015 ships write tools off at every layer. When an owner turns them on, the P7-25 addendum defaults
`RB_WRITE_APPROVAL` to `client`: a connection that cannot show the person an elicitation form may still write with
`confirm: true`. That literal is produced by the model, so on such a connection a prompt-injected model (T6) is the
only gate before a mutation (T31). Turning writes on is already a deliberate act, so the person doing it should get the
safest approval mode unless they lower it on purpose.

## Decision
- `RB_WRITE_APPROVAL` defaults to **`required`** on every runtime (`serve`, Worker, stdio). `client` remains available as
  an explicit opt-down and the server logs a warning at startup when writes are on with `client`.
- Everything else in the P7-25 addendum is unchanged: server-level only, no admin API/project/grant override, write
  tools stay listed and a refused call explains why.
- Implemented by task P7-33.

## Consequences
- Clients that cannot be asked (no elicitation capability, `elicitWrites: false`, stateless 2025-era HTTP, Workers
  without elicitation) can dry-run but not apply writes until the owner sets `client`.
- Docs and the startup warning must state the trade-off; the warning that exists today for `client` + writes stays.
