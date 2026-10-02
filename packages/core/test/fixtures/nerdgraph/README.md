# NerdGraph fixtures

Sanitized responses captured by spike P0-09 (`spikes/nerdgraph/`) on 2026-10-02 from real US accounts, then reviewed:

- account ids → `1000001…`, user ids → `2000001…`, GUIDs re-encoded with fake ids
- names → `name-N`, tag values → `tag-N` / fake ids, emails → `user-N@example.com`, URLs → `…/REDACTED`
- leak check against every real value in the raw mapping: 0 hits; gitleaks: clean

Each file is `{ probe, profile, region, endpoint, note, at, request: { query, variables }, response: { status, headers, body } }`.
The account had no recent APM/Log data, so result rows are mostly empty. Shapes, errors and metadata are what matter here.

**Never add unsanitized captures.** Re-capture with `node probe.ts && node sanitize.ts` in `spikes/nerdgraph/`, review per its
README checklist, then copy.
