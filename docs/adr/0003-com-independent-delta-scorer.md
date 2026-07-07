# 0003 — COM: independent scorer, control+variant delta

**Decision:** the Conversion Optimization Model is a separate Haiku call in its own context (`lib/com.ts` imports nothing from agent/stores) scoring BOTH control and variant; the delta is reported. Its prompt states the goal but never enumerates criteria.
**Why:** generator ≠ evaluator keeps the signal clean; unanchored single scores cluster ~0.7 and read as arbitrary; enumerated criteria would leak the rubric into generation. Honest framing everywhere: zero traffic → a prior, not conversion data.
