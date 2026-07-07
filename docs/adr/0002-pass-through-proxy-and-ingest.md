# 0002 — Byte-level pass-through proxy; ingest = fetch + base href + inject

**Decision:** `/api/anthropic` forwards bytes untouched (never parse/re-emit SSE). `/api/ingest` rewrites with `<base href>` only (no absolutization pass), strips CSP meta + third-party experiment scripts, injects the runtime.
**Why:** protocol-translating proxies break multi-step tool streaming (LiteLLM-class bugs). `<base>` resolves all relative URLs by itself — but forces the runtime's link-click interceptor.
**Validated:** fidelity near-pixel-perfect on the test set with injected script executing (scripts/proxy-spike.mjs + shots/).
