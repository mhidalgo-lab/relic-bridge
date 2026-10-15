---
"relic-bridge": patch
---

`get_dashboard` now returns each widget's visualization. Every widget used to read back with `visualization: null`, because New Relic's dotted ids (`viz.line`) failed the code-label check. Built-in charts show as `line`, `area`, `bar`, `billboard`, `pie`, `table` and `markdown`, the values `create_dashboard` takes; other ids appear in full when they match a strict pattern. The observability dashboard's "Server error %" widget no longer says it needs an unreleased version.
