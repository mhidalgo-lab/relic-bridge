---
'relic-bridge': patch
---

`list_recent_issues` no longer falls back silently (0.9.0 verification, NEW-09). When `group_by` counts only the page, `groupsNote` (and a text note) says why and how many issues the counts cover (window too large for the extra requests, request budget, or a failed request). A `limit` above the API page size (50 rows) is reported as `limitNote`, e.g. "limit 200 lowered to 50 (API page size)", instead of returning fewer rows without a word.
