---
'relic-bridge': patch
---

Bound redaction and NRQL masking work on long input: every secret pattern now does work linear in the input, and
output cells, trailers, column names, error messages and the audit NRQL column redact only the text they keep (with a
margin so a secret crossing the cap is still recognised). An unterminated NRQL string ending in a backslash is now
masked too.
