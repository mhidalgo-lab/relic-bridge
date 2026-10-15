---
"relic-bridge": minor
---

CLI fixes:

- `relic-bridge doctor` no longer changes what it checks. It opens the database read-only. Before, it set the file
  mode to `0600` and the journal mode to WAL, then printed a `chmod 600` warning from the old mode. Now the warning
  stands until you fix it. The new `doctor --fix` sets a group- or world-accessible database file to `0600` and says
  what it changed.
- `audit purge --older-than-days` takes a whole number of days from 1 to 99999. A value such as `1.5`, `1e3` or `0x10`
  is refused with exit code 2, by the command itself as well as by the argument parser.
- `config import` and the Admin API now use the same 1 MiB limit. `POST /config/import` accepts bodies up to 1 MiB
  (it was 64 KiB, too small for a bundle with encrypted keys). The CLI refuses a larger file, or a larger import
  request, before sending it, and its error message gives the limit. The other admin routes keep the 64 KiB limit.
- The `RB_AUDIT=off` startup warning (`serve` and the Worker) now says that it disables every audit row: tool
  calls, refusals and admin changes.
