# Overlay — an agentic harness for building optimized experiments on any live website

Paste **any live URL** into a chat. An agent reads the page, produces a grounded **Page Brief**
(design system, brand language, ICP, pain points, accessibility audit), then proposes and applies
**A/B-test variants** to a live preview — each pre-scored by an independent **Conversion
Optimization Model (COM)**, each gated by human approval — and finally **exports a runnable,
dependency-free experiment script** you can paste onto the real page.

It's **Claude Code's shape** — agent loop, tool belt, context-by-exploration, permission gates,
persistent per-site memory — pointed at a webpage you *don't own* instead of a repo.

> **Why this exists / relevance to Coframe.** Coframe's product is autonomous, LLM-driven
> landing-page optimization: agents that understand a page, generate variants, and run continuous
> experiments. Overlay is a from-scratch, single-operator take on that exact loop —
> *understand → generate → score → ship an experiment* — built to show the engineering
> underneath: a browser-side agent that reasons over a real DOM, a deterministic scorer kept
> honest by construction, and the guardrails (sandboxing, injection defense, human approval) that
> make "an agent editing a stranger's website" safe to demo.

---

## The loop, end to end

```
 URL ─▶ ingest (sandbox + inject) ─▶ typed component schema ─▶ Page Brief + Experiment Plan
                                                                      │
        exportable A/B <script>  ◀── COM-scored variants ◀── agent proposes ops (human-approved)
```

1. **Ingest** — fetch the page server-side, strip CSP/third-party experiment scripts, inject a
   `<base href>` and our runtime, and serve it **same-origin** so it can be scripted safely in an
   iframe. SSRF-guarded; bot walls and non-HTML are reported cleanly, never guessed at.
2. **Extraction** — a deterministic ladder (per-site profiles → framework fingerprints → semantic
   HTML → layout heuristics) turns the page into a **typed component schema** with computed facts
   (line counts, font px, WCAG contrast) and an ADA audit.
3. **Understand** — the agent streams a **Page Brief** (`generateObject`, every field grounded to a
   real extracted component — invented paths are dropped app-side) and an **Experiment Plan**
   (6–10 hypotheses, each targeting a validated component path).
4. **Generate** — natural-language instructions become **constrained ops** against the schema,
   shown as slot-level diff cards you **approve or reject**. Variants become **tabs** (Control · A ·
   B · …); switching replays that arm's ops over a clean control.
5. **Score** — an **independent COM** rates control vs. variant and reports the **delta**. The
   gallery ranks arms and labels a prior-based traffic allocation (control 25%, rest ∝ deltas).
6. **Export** — any saved variant becomes a **dependency-free `<script>`** (<2 KB): visitor
   bucketing in localStorage, `window.__overlayVariant` exposed for the site's own analytics, and
   a fingerprint re-check against the original page (warn-and-skip on mismatch — never guesses).
   Zero network calls; you measure with your existing analytics.

Honest limits are part of the product: bot walls, hydration fights that wipe a patch (`op-wiped`),
and failed detection are **surfaced, not papered over**.

---

## Architecture

| Layer | What it does | Key files |
|---|---|---|
| **Ingest proxy** | Fetch + rewrite + inject runtime; SSRF guard; same-origin serve | `app/api/ingest/route.ts` |
| **Iframe runtime** | Runs *inside* the proxied page; applies/reverts ops; measures regressions; **dependency-free** (must survive any third-party page) | `lib/runtime.ts` |
| **Key proxy** | Byte-level pass-through to Anthropic; the API key never reaches the browser | `app/api/anthropic/[...p]/route.ts` |
| **Agent loop** | Browser-side `streamText` loop: tool belt, streamed reasoning, prompt caching, per-turn telemetry | `lib/agent.ts`, `lib/tools.ts`, `lib/prompts.ts` |
| **Extraction** | Deterministic schema ladder + computed facts + ADA audit | `lib/runtime.ts` (extract), `lib/profiles.ts` |
| **Brief / Plan** | Grounded structured generation; app-side path validation | `lib/brief.ts` |
| **Variants + COM** | `create_variant`/`score_variant`, tabs, gallery, warn-only regression checks | `lib/variants.ts`, `lib/com.ts`, `lib/tools.ts` |
| **Export** | Dependency-free multi-arm applier snippet | `lib/export.ts` |
| **Site memory** | `.memory/<hostname>/` — brief/variants/verdicts persisted; resume-on-reopen | `app/api/memory/route.ts` |
| **Password gate** | Shared-password auth on every API route before public deploy | `lib/auth.ts`, `app/api/auth/route.ts` |

**Engineering decisions worth calling out:**

- **Generator ≠ evaluator.** `lib/com.ts` (the scorer) imports *nothing* from the agent or the
  stores — it can't see how a variant was made, only what it is. The generator proposes; an
  independent model judges. (Enforced as a hard rule + verified in review.)
- **The runtime is dependency-free by contract.** It executes inside pages we don't control, so it
  uses only plain DOM/CSSOM — no bundler globals, no host assumptions.
- **Tools never throw across the postMessage boundary.** Every tool returns JSON/strings; a
  30s-timeout or "iframe not ready" becomes `{error}`, never a wedged UI. Every message carries a
  `requestId`.
- **Prompt-injection defense.** Page-derived text is wrapped in `<<<PAGE … PAGE>>>` markers in
  *both* the system prompt and every page-bearing tool result; the agent is trained to treat it as
  data, and a fixture test proves it refuses embedded instructions.
- **Everything is a runnable pass.** Each milestone's acceptance criteria are encoded as Playwright
  specs (`@m1…@m5`, `@ai` where a live model is needed, `@smoke` keyless). CI records a
  screenshot + video for every test; a `harness-lint` gate fails any code PR that ships no specs.

---

## Status

Built milestone-by-milestone, each behind CI + an adversarial pre-merge review:

| Milestone | What | State |
|---|---|---|
| M1a | Shell · ingest proxy · iframe runtime · op pipeline | ✅ merged |
| M1b | Agent tick: loop, streamed reasoning, diff ProposalCard | ✅ merged |
| M2a | Deep extraction: full ladder, node facts, ADA audit | ✅ merged |
| M2b | Page Brief · Experiment Plan · settings · project context | ✅ merged |
| M3 | Variants: `create_variant`, tabs, gallery, COM scoring, warnings | ✅ merged |
| Gate | Password gate on every API route (public-deploy readiness) | 🟢 in review |
| M5 | Export: deployable A/B `<script>` (**MVP closes here**) | 🔨 in progress |
| M4 | Site memory: `.memory/<hostname>/`, resume-on-reopen | ⏭ next |
| Gate run | Full-arc E2E + failure/injection laps + reference video | ⏭ final |

---

## Run it locally

```bash
pnpm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local   # read only in app/api/** — never bundled
pnpm dev                                            # http://localhost:3010
```

Try `https://maxtechera.dev`, then: read the brief → "three different hero angles" → approve a
proposal → switch variant tabs → export the snippet. See **[DEMO.md](DEMO.md)** for the guided
walkthrough.

*(Deployed builds sit behind a shared password — set `APP_PASSWORD` in the host env; unset locally
= no gate.)*

---

## Built in the open, by a team of agents

This repo is built by AI agents working from three contracts, with humans approving every merge:

- **[PRD.md](PRD.md)** — what & why: the flow, milestones, and each milestone's runnable pass.
- **[TECH-SPEC.md](TECH-SPEC.md)** — how: pinned versions, code contracts, prompts, protocols.
- **[CLAUDE.md](CLAUDE.md)** — the agent team's operating manual + append-only learnings.

An orchestrator delegates one issue per milestone to a worker, an independent reviewer tries to
*refute* every PR before merge (generator ≠ evaluator, applied to the code too), and nothing merges
red or without evidence mapped to its acceptance criteria. The git history and PRs *are* the
build log.
