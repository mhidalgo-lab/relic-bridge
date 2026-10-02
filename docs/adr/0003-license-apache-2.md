# 0003 — Apache-2.0 license with DCO

- Status: accepted
- Date: 2026-10-01

## Decision
- License: **Apache License 2.0** (`LICENSE` + `NOTICE`). It includes an explicit patent grant and is common for
  infrastructure tooling. New Relic's own Claude plugin uses it too.
- Contributions under the **Developer Certificate of Origin** (`Signed-off-by:` trailer, checked in CI) instead of a CLA:
  less friction for contributors.
- Each source file starts with a short SPDX header: `// SPDX-License-Identifier: Apache-2.0`.
- Dependencies must use compatible licenses (MIT, BSD, ISC, Apache-2.0, …). CI fails on GPL/AGPL/unknown (P0-04).
