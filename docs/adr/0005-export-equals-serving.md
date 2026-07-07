# 0005 — The exported snippet and dynamic serving are the same mechanism

**Decision (M5/M10):** export = ops JSON + standalone applier with 50/50 persisted bucketing, assignment exposed for the site's analytics (we never measure). The future variant server (`/api/serve/<site>.js`) returns the SAME applier with ops fetched from site memory.
**Why:** the north star (dynamically served, autonomously generated variants) becomes a serving change, not a rewrite — and the MVP's output is a runnable experiment, not a mockup.
