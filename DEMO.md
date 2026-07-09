# Overlay — demo script

A ~3-minute guided walkthrough of the full arc: **understand → generate → score → ship**. Works
on the live deployment (enter the shared password when prompted) or locally (`pnpm dev`).

> **The one-liner to open with:** *"Overlay points a Claude-Code-style agent at any live URL — it
> reads the page, writes an optimization brief, proposes and scores A/B variants against an
> independent model, and exports a runnable experiment. It's the Coframe loop, built to show the
> engineering underneath."*

---

## 0. Setup (before the call)
- Have the deployed URL + password ready (or `pnpm dev` running).
- Use `https://maxtechera.dev` as the demo site — it's the tuned target; extraction is
  deterministic and the brief/plan are grounded.

## 1. Analyze a real site *(~20s)*
- Paste `https://maxtechera.dev`, hit **Analyze**.
- **Say:** *"It's fetching the real page server-side, sandboxing it same-origin, injecting a
  runtime, and extracting a typed component schema — not scraping text, building a structured model
  of the page."*
- Point at the extraction summary: **hero, sections, cards, computed facts, ADA findings**.

## 2. The Page Brief + Experiment Plan *(~40s)*
- The agent auto-streams a **Page Brief**: ICP, problem, value prop, segments, CTA audit, a11y.
- **Say:** *"Every field is grounded — the app validates each referenced component against the real
  schema and drops anything the model invents. No hallucinated claims."*
- Scroll to the **Experiment Plan**: 6–10 hypotheses, each targeting a real component path.
- *(Optional flex)* Edit the ICP inline → next turn reflects it. Or open the **project-context**
  panel, add "never touch pricing copy," and later watch the agent refuse a pricing edit.

## 3. Generate variants *(~40s)*
- Type: **"Give me three different hero angles."**
- **Say:** *"Natural language becomes constrained ops against the schema — I approve or reject each
  one as a slot-level diff. Nothing changes the page without a human OK."*
- **Approve** one proposal → the live preview updates. **Reject** one with a reason → the agent
  acknowledges and adjusts.
- Show the **variant tabs** (Control · A · B · C) — switch between them; the preview reverts to
  control and replays each arm's ops.

## 4. Score — the independent model *(~30s)*
- Open the **variant gallery** in chat.
- **Say:** *"An independent Conversion Optimization Model scores each variant against control and
  reports the delta. Crucially, the scorer shares no code with the generator — it can't see how a
  variant was made, only what it is. Generator ≠ evaluator."*
- **The honesty beat:** type **"make it vague and generic"** → the COM returns a **negative delta**
  and the agent reports it plainly. *"It doesn't cheer for its own work."*

## 5. Ship it — the export *(~30s)*
- Open the **Export** block, pick a variant, **Copy the `<script>` tag**.
- **Say:** *"This is the payoff: a dependency-free, <2 KB snippet. It buckets visitors, persists the
  assignment, exposes `window.__overlayVariant` for your existing analytics, and re-checks a
  fingerprint against the original page — if the page changed, it warns and skips rather than
  guessing. Zero network calls; you measure with GA4/PostHog or inject it at the edge."*
- *(If time)* Paste the console version on the **real** maxtechera.dev in a clean tab → the variant
  applies immediately.

## 6. Close — the engineering story *(~20s)*
Pick two, depending on the interviewer:
- *"The runtime that edits the page is dependency-free by contract — it runs inside sites we don't
  control."*
- *"Page-derived text is fenced as untrusted in both the prompt and every tool result — prompt-
  injection defense, with a test that proves the agent refuses embedded instructions."*
- *"Every milestone's acceptance criteria are runnable Playwright specs; CI records a video of each,
  and no code merges without tests. An independent agent reviewer tries to refute every PR before
  merge."*
- *"Reopen a URL and it resumes from a per-site memory file — a CLAUDE.md for the website."*

---

## If something goes sideways (talking points, not failures)
- **Bot wall / non-HTML site** → clean pre-flight error in chat. *"It reports honest limits instead
  of hallucinating a page."*
- **A patch gets wiped by the site's hydration** → reported as `op-wiped`. *"It tells you when the
  page fought back."*
- **A site with no detectable hero** → the agent says so plainly rather than inventing structure.

## Backup
A recorded reference run lives in the MVP-gate issue (#5) — link it if a live demo isn't possible.
