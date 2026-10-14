---
'relic-bridge': patch
---

`get_attributes` now applies `name_contains` before the 1,000-attribute cap (NEW-08). On event types with more than 1,000 attributes, such as Log, a filter whose matches sat past the cut returned an empty list with `truncated: true`. `totalAttributes` is the real count before filter and cap, and `truncated` means the filtered list shown was cut.
