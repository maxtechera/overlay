# Overlay

**Point an agent at any live URL. It reads the page, writes an optimization brief, proposes and
scores A/B‑test variants against an independent model, and hands you a runnable experiment you can
paste onto the real site.**

Overlay is Claude Code's shape — an agent loop with a tool belt, context gathered by exploration,
human approval gates, and per‑site memory — turned outward, at a webpage you don't own instead of a
repository. It's a single‑operator take on the loop behind autonomous landing‑page optimization:
*understand → generate → score → ship*, with the guardrails that make "an agent editing a
stranger's website" safe to run and safe to demo.

> **Live demo:** <https://coframe-pagebuilder.vercel.app> — password‑protected (shared with
> reviewers). Everything up to the agent works out of the box; the live agent needs an API key +
> credits configured on the deployment (see *Running it*).

---

## What it feels like to use

You paste a URL and hit analyze. A minute later the right pane shows the real page, rendered
faithfully, with a translucent overlay boxing each piece it understood — the headline, the subhead,
the body, the calls to action. The left pane is a conversation.

The agent introduces the page back to you: a grounded **brief** (who it's for, the problem it
solves, the value proposition, an accessibility pass, a couple of addressable audience segments) and
an **experiment plan** — six to ten concrete hypotheses, each aimed at a component that actually
exists on the page.

You ask for changes in plain language. "Three different hero angles." Each edit arrives as a
slot‑level **diff card** you approve or reject; approved edits change the live preview immediately.
Variants collect into a small **carousel** you flip through — each labeled with a **conversion
score** and a delta versus control, computed by a model that had no hand in writing it. Ask it to
"make the copy vague and generic" and it will build that variant, score it *negative*, and tell you
so plainly.

When you're happy, you export. Out comes a **dependency‑free `<script>`** under a couple of
kilobytes: it buckets visitors, persists their assignment, exposes the choice to your existing
analytics, re‑finds each element on the live page by a fingerprint (and skips rather than guesses if
the page has changed since), and makes zero network calls of its own. Paste it in a `<head>` and the
experiment is running.

---

## The problems worth talking about

Most of the engineering here is in the seams — the places where "drive an agent over a live third‑
party page" stops being obvious.

**Scripting a page you don't control.** A remote page can't be embedded and scripted from another
origin. Overlay fetches it server‑side, strips the Content‑Security‑Policy and any third‑party
experimentation scripts that would fight it, injects a `<base href>` and a small runtime, and serves
the result *same‑origin* from its own host. The fetch is guarded against SSRF (no localhost, no
private ranges), and pages that can't be served cleanly — bot walls, non‑HTML — are reported as a
clean error instead of a hang.

**Images that vanished on hydration.** Early on, ingested pages rendered with every image broken.
The served HTML was correct — root‑relative optimizer URLs resolved against the target origin via
the injected `<base>`. But the *target's own framework runtime*, once it hydrated inside the iframe,
**deleted the `<base>` tag and rewrote every `src` back to a root‑relative path**, so the browser
went looking for the images on Overlay's host and got HTML back. The fix is two layers: absolutize
asset URLs at ingest time for the first paint, and a small **`MutationObserver` inside the runtime**
that re‑absolutizes any `src`/`srcset` the page tries to revert — surviving hydration without
freezing the page. (An adversarial review caught the first, HTML‑only fix passing its test while the
images were still visibly broken; the lesson — *"a served‑HTML assertion is not proof of rendering"*
— is now written into the project's operating notes.)

**Keeping the generator honest.** The conversion model that scores variants imports nothing from the
agent or the application stores. It can see *what* a variant is, never *how* it was made — so it
can't root for its own work. The separation is a hard rule in the codebase and is checked on every
change; it's why "make it worse" produces an honest negative score instead of a rationalization.

**A runtime that has to survive anywhere.** The code injected into the third‑party page is
dependency‑free by contract — plain DOM and `MutationObserver`, no bundler globals, no assumptions
about the host — because it runs inside pages nobody vetted. Every message it exchanges with the app
carries a request id, and every tool the agent calls returns a value rather than throwing across the
`postMessage` boundary; a timeout becomes an error string, never a wedged interface.

**Treating page content as untrusted input.** Text extracted from the page is a prompt‑injection
surface. It's fenced with explicit markers in both the system prompt and every tool result, and the
agent is instructed to treat anything inside those markers as data — with a fixture test proving it
refuses an instruction smuggled in through page copy.

**Grounding, not vibes.** The brief and the plan are generated as structured objects and then
validated against the real extracted schema: a hypothesis that targets a component the page doesn't
have is dropped before it ever reaches you, and a CTA the model invented is stripped from the audit.
No claim survives that doesn't trace to something on the page.

**Honest limits as a feature.** Bot walls, pages with no detectable hero, and edits that a site's own
hydration later wipes out are all surfaced, not papered over. A tool that quietly guesses is worse
than one that tells you it couldn't be sure.

---

## What's in the box today

- **Ingest & sandbox** — fetch, sanitize, inject runtime, serve same‑origin; SSRF‑guarded; clean
  failure reporting.
- **Deterministic extraction** — a ladder of per‑site profiles → framework fingerprints → semantic
  HTML → layout heuristics turns a page into a typed component schema, with computed facts (line
  counts, font sizes, WCAG contrast) and an accessibility audit.
- **The agent tick** — a browser‑side streaming loop with a tool belt, visible reasoning, prompt
  caching on the stable context, and per‑turn token/latency telemetry.
- **Understanding artifacts** — a grounded, editable Page Brief and an Experiment Plan of targeted
  hypotheses; a project‑context panel and a model/thinking control that take effect on the next turn.
- **A fine‑grained overlay** — slot‑level boxes (title, subtitle, body, CTA) drawn over the live
  preview, on by default; click a box to carry that element into your next message as context.
- **Variants & scoring** — natural‑language edits become approve/reject diff cards; variants become
  tabs and a compact carousel, each pre‑scored by the independent conversion model with a
  prior‑labeled traffic split; warn‑only regression checks (overflow, line growth, contrast, lost
  alt text) flag risky edits without blocking them.
- **Export** — a dependency‑free, self‑contained applier snippet with visitor bucketing, a
  fingerprint re‑find that warns‑and‑skips on mismatch, a force‑preview hash, and zero telemetry of
  its own.
- **A password gate** — a shared‑password guard on every API route so the deployment can go public
  without turning the proxy into an open door to the API key.
- **Deployed** — live on Vercel behind the gate.

The full user arc — analyze a page, read the brief, build and score variants, export, run the snippet
on the original page — works end to end. The one thing the public deployment needs to exercise the
*live agent* is an API key and credits on the hosting side; the rest is already there to click
through.

---

## How it's built

```
 Chat + agent loop (browser) ──postMessage──▶ runtime injected into the proxied page
        │                                              ▲
        └── HTTP ──▶ /api/anthropic  (key proxy)       └── /api/ingest  (fetch · sanitize · inject)
                     /api/auth       (password gate)
```

A thin Next.js app hosts three server routes — a byte‑level pass‑through proxy that keeps the API key
on the server, the ingest/sanitize endpoint, and the auth gate. Everything else runs in the browser:
the agent loop, the stores, the extraction and overlay logic (bundled into the injected runtime), the
conversion model, and the export builder. The stack is deliberately pinned — a specific SDK pairing
that streams multi‑step tool calls correctly — and the UI is assembled from a shadcn/AI‑Elements kit
rather than hand‑rolled.

**Built in the open, by a team of agents.** This repository was implemented milestone by milestone by
a small orchestration of AI agents working from three checked‑in contracts — a product spec, a
technical spec, and an operating manual with an append‑only log of hard‑won lessons. An orchestrator
delegated one issue per milestone to an implementer; an independent reviewer then tried to *refute*
every pull request — in a real browser, not just against the tests — before anything merged. Nothing
merged red, and nothing merged without evidence mapped to its acceptance criteria. That adversarial
step repeatedly paid for itself: it's what caught the image fix that looked right but didn't render,
and a resize handle that silently died the moment the cursor crossed onto the preview. The git
history and the pull requests are the build log.

---

## What's considered but not yet built

Scoped, understood, and deliberately left for later:

- **Per‑site memory** — a file‑backed, agent‑curated memory per hostname, so reopening a URL resumes
  the whole project (brief, variants, verdicts) and the agent greets you with what it already knows.
- **Autonomous serving loop** — dynamic variant serving with a generate‑test‑learn cycle, the
  north‑star version of the product.
- **Bandit simulation** — a Thompson‑sampling loop over synthetic traffic, seeded by the conversion
  model's prior.
- **Structural edits** — adding, removing, duplicating, and cloning‑and‑filling whole sections, not
  just editing existing copy.
- **A verify loop** — post‑apply QA checks with self‑correction retries and proof artifacts.
- **Breadth** — tuning the extraction ladder against more sites beyond the primary target, plus an
  evals suite for extraction and scoring.
- A short list of tracked robustness refinements from the reviews.

---

## Running it

```bash
pnpm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local   # read only on the server, never bundled
pnpm dev                                            # http://localhost:3010
```

Analyze `https://maxtechera.dev` (the primary tuning target) and walk the arc: read the brief, ask
for "three different hero angles," approve one, flip through the carousel, export the snippet.

Deploying publicly requires `APP_PASSWORD` in the host environment — unset locally, the gate is off
and nothing changes for development. The live deployment additionally needs `ANTHROPIC_API_KEY` set
on the host for the agent to run.

The three contracts that drove the build live alongside this file: **[PRD.md](PRD.md)** (what and
why), **[TECH-SPEC.md](TECH-SPEC.md)** (how — pinned versions, interfaces, prompts, protocols), and
**[CLAUDE.md](CLAUDE.md)** (the operating manual and lessons log). A guided walkthrough for a live
demo is in **[DEMO.md](DEMO.md)**.
