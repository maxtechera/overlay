# Overlay — an agentic harness for building optimized experiments on any live website

Paste **any live URL** into a chat. The agent reads the page, produces a **Page Brief** (design
system, brand language, ICP, pain points), then proposes and applies **A/B test variants** to a
live preview — each pre-scored by an independent **Conversion Optimization Model**, each gated by
human approval, everything remembered per site in a CLAUDE.md-style memory file.

Claude Code's shape — agent loop, tool belt, context-by-exploration, permission gates,
persistent memory — pointed at a webpage you don't own instead of a repo.

**Status: spec complete, build starting.** Both architectural risks were validated with real
runs before any product code: the ingest proxy renders real production sites near-pixel-perfect with our runtime injected, and a multi-step tool loop streams through the
pass-through proxy on the pinned deps. Evidence: `scripts/` + `scripts/shots/`.

## Built in the open, by agents

This repo is built by a team of AI agents working from two contracts:

- **[PRD.md](PRD.md)** — what & why: flow, architecture, milestones with runnable passes.
- **[TECH-SPEC.md](TECH-SPEC.md)** — how: pinned versions, code contracts, prompts, protocols.
- **[CLAUDE.md](CLAUDE.md)** — the agent team's operating manual.

Work is delegated through issues (one per milestone, acceptance criteria included). PRs carry
evidence that the milestone's pass runs green. Humans approve; agents build.

## Run it

```bash
pnpm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local
pnpm dev   # http://localhost:3010
```

## How it works (one page)

```
Chat + agent loop (browser) ──postMessage──> iframe runtime (injected into proxied page)
       │                                            ▲
       └─HTTP─> /api/anthropic (key proxy)          └── /api/ingest (fetch + rewrite + inject)
                /api/memory   (.memory/<hostname>/ — site memory, CLAUDE.md pattern)
```

The page becomes a typed component schema (deterministic extraction ladder — per-site profiles →
framework fingerprints → semantic HTML → layout heuristics). Every edit, human or agent, is a
constrained op against that schema. An independent scorer rates control vs variant and reports
the **delta**. Honest limits are part of the product: bot walls, hydration fights, and failed
detection are reported, not papered over.
