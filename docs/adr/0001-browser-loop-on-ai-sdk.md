# 0001 — Agent loop runs in the browser on Vercel AI SDK core

**Decision:** the loop is `streamText` (ai@6) in the parent window behind a byte-level key proxy — not the Claude Agent SDK, not `useChat`, not subscription auth.
**Why:** every tool touches the iframe, which lives in the browser — in-process tools eliminate the server↔client tool bridge (correlation ids, SSE session, tool-result endpoint ≈ a third of the backend). Approval becomes one awaited promise. Subscription auth would also share rate windows with interactive use — a live-demo risk.
**Cost:** API billing (small); runs die with the tab (fine, site memory resumes).
**Validated:** step-0 spike green through the pass-through proxy (scripts/step0-spike.mjs).
