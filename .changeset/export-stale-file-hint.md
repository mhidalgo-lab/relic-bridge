---
"relic-bridge": patch
---

`db export` names the modification time of an existing destination it refuses to overwrite, so a stale export is easy to spot, and its closing hint says how to delete the file (`rm`, and the `docker exec … node -e` form for a path under `/data` in the distroless image).
