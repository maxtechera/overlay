# PRD — Any-Site Variant Builder (working name: **Overlay**)

Paste **any live URL** — a site we don't own — into a chat. The agent reads the page, produces a
**Page Brief** (design system, brand language, ICP, pain points), and then proposes and applies
**A/B test variants** to a live preview, each one **pre-scored by an independent Conversion
Optimization Model**. One script on someone else's site, variants for experiments — the
website-optimization-platform model, not the CMS model where you own the build.

**Optimized for: fastest path to a working demo, least code.** Every cut below is deliberate and
listed in §8 so we can say it out loud instead of getting caught by it.

> ## HANDOFF STATUS (2026-07-07)
> **Ready to build — start at §10 step 1.** No open decisions, no unvalidated architecture.
> - **Validated by real runs** (scripts in `scripts/`, keep as regression checks):
>   proxy fidelity on the test set (`proxy-spike.mjs` + screenshots in
>   `scripts/shots/`) · multi-step tool loop through the pass-through proxy on pinned deps
>   (`step0-spike.mjs`, green).
> - **Environment ready:** `ANTHROPIC_API_KEY` in `.env.local` (gitignored) · `ai@6` +
>   `@ai-sdk/anthropic@3` pinned and installed · Next 15 scaffold in place.
> - **How to build:** follow §10's build order, one commit per step; code contracts live in
>   **TECH-SPEC.md** (follow its §0 pins exactly — the version traps in it were hit for real).
>   A milestone is done when its §7 pass runs green, not when code exists.
> - **Sequencing is by dependency, not dates:** M1 → M2 → M3 → M4 → M5 → MVP gate (#5), strictly in
>   order (each pass builds on the previous). After M5, the tail fans out: M6 (evals) · M7
>   (verify) · M9 (bandit sim) are independent of each other; M8 (structure) depends on M7.

---

## 1. Why this, and the thesis

The hard part of AI website optimization is operating on a page you **don't** control: read the live
DOM, understand it well enough to change it, and generate variants that stay on brand and don't
break layout.

**This app does exactly two things well, and everything in it serves one of them:**
1. **Understand any live page** — deterministically extract its design system, components,
   patterns, node facts ("headline wraps to 2 lines at 48px"), and an **ADA/accessibility
   audit**.
2. **Generate variants that are validated, verified, and CRO-optimized** — constrained ops
   against the extracted schema (validated), checked with evidence (verified), anchored to the
   brief and independently scored (optimized).

**Thesis:** extract a component schema from the live page, constrain every edit (agent or human)
to typed ops against that schema, keep the human approving — and a scorer rides alongside as
**signal, not decider**.

**Meta-goal:** a Claude-Code-shaped harness for the open web — thin off-the-shelf loop, and
our substance in the tool belt, context strategy, and the surface the agent drives. Claude Code
pointed at a repo; this pointed at a page you don't own.

---

## 2. Core user flow

Surface = **chat (left) + live preview (right)**.

1. **First message is the URL.** The agent's first turn ingests the page (proxy → iframe, §4.1),
   runs extraction (§4.2), and replies with the **Page Brief artifact**: SEO basics, component
   outline, ICP, problem statement, pain points, objections, proof/CTA audit, suggested goals.
   Saved, human-editable, pinned into context for every later turn.
2. Every extracted block is **addressable**: stable id + selector + human path (`hero.headline`).
   Ops can target any level — text in a card, a button's label+href, a whole section.
3. The preview shows a labeled **overlay** and **variant tabs: Control · A · B · (+)**. A
   variant = a named, ordered op list against control (replayable, revertible). Switching tabs
   reverts to control and replays the selected variant's ops — instant comparison in place.
4. The user directs from chat ("make the hero speak to CTOs", "give me three different
   angles"). The agent explores via tools — transcript visible — **saves its recommendations as
   named variants** (`create_variant`) and proposes ops as **actionable cards, pre-scored by
   the COM** (§4.4). Approve → applies to the active variant, live in the preview. After saving
   multiple variants the agent renders the **variant gallery inline in the chat** — one card
   per variant (thumbnail, COM delta, segment tag), click to switch the preview; also available
   any time by asking.
5. Everything learned persists to **site memory** (§4.5): verdicts, the brief, learnings the
   agent chooses to keep. **Reopening the same URL resumes the project** — brief loads from
   disk, the agent picks up where it left off.
6. **Export (§4.6): pick a variant and it leaves the tool as a deployable A/B script** —
   copy/paste it into your site (or inject it at the edge): it buckets visitors 50/50, applies
   that variant's ops for the test group, and exposes the assignment for your analytics. The
   full arc ends with something you can actually run as an experiment.

**First tracer:** identify the **hero** only, update its **copy + link** from chat. One
component, end-to-end through every layer.

---

## 3. Goals / Acceptance / Non-goals

**MVP goals**
- Works on a real third-party URL (including one the audience pastes).
- Page Brief artifact from the agent's first turn — proves "we understood the page *and* the
  business."
- Agent proposes ops at block/card/section granularity, anchored to the brief + goal; every
  proposal arrives with an independent COM score; human approves.
- **Rich chat**: tool calls displayed live, and components / proposals / variants / the brief
  render as interactive inline blocks (§4.3) — the user drives by clicking *and* chatting, in
  both directions (click in preview → reference in chat; click in chat → highlight in preview).
- **Multiple saved variants, compared**: agent recommendations persist as named variants;
  switch between Control/A/B/C live in the preview; rank them by COM delta.
- **Any variant is exportable as a runnable A/B script** (§4.6): paste into the real site (or
  edge-inject), visitors get bucketed, the test group gets the variant. The MVP's output is an
  experiment, not a mockup.

**Acceptance bar** (dev test set in TECH-SPEC §10, proxy-validated)
1. A genuinely static page: full flow.
2. A hydrated Next.js marketing site (`maxtechera.dev` is this tier, not tier 1): text/CTA ops
   work post-hydration; if the site's JS wipes a patch, the runtime detects and reports it.
3. Bot-walled site: fails fast with a clear error in chat — predicted failure is a pass.

**Non-goals (MVP):** production SDK · multi-tenant · real traffic/experiments · SSR of variants ·
perfect extraction. §8 has the full cut list.

---

## 4. Architecture (one page, three dumb routes)

```
Chat + loop (browser) ──postMessage──> iframe runtime (injected into proxied page)
       │                                      ▲
       └──HTTP──> /api/anthropic (key proxy)  └── /api/ingest (fetch + rewrite + inject)
                  /api/memory (read/write .memory/<hostname>/)
```

### 4.1 Ingest — `GET /api/ingest?url=`
Real sites block iframing (`X-Frame-Options`/CSP) and cross-origin frames can't be scripted, so:
fetch server-side (Chrome UA) → parse with `node-html-parser` → strip CSP `<meta>`, inject
`<base href="<url>">` (this alone resolves every relative and root-relative `src/href/srcset` —
no manual absolutization pass needed), inject our compiled `runtime.ts` before `</body>` → serve
from our origin (same-origin, scriptable). The runtime installs a document-level **click
interceptor** (`preventDefault` on all `<a>`) — with `<base>` pointing at the target origin, any
real click would navigate the preview away and kill the session. Also **strip third-party
experimentation scripts** (Optimizely, VWO, AB Tasty — a small known-src list): they are
competing DOM mutators that rotate content mid-session and fight our patches; the fidelity spike caught
a site's own optimizer doing exactly this. Cloudflare/bot-challenge markers or non-HTML →
`422 { reason }`, surfaced as a plain chat message. Conceptually this IS the "one script you
install" deployment model.

### 4.2 Extraction (runs in the iframe runtime, client-side — needs computed styles/layout)
Classify into `hero | section | card | collection | text | media | link`, where `text` carries a
`variant` (`h1|h2|h3|p|label`) from **computed type scale, not the tag** (half the web puts h1
styles on a div). M1 detects only the hero (§10 step 3); the full walk lands in M2; card/collection
pattern-mining lands with structural ops (M8). The runtime also reads SEO basics
(title/meta/OG/h1–h3) off the DOM — no separate server path.

**Deterministic by requirement — pure code, no LLM, same input → same schema.** Detection is a
**ladder of signals**, strongest first:
1. **Per-site profiles (the sanctioned cheat):** a hostname → overrides map tuned for the demo
   test set (posthog.com, maxtechera.dev, astro.build) — known selectors for hero/sections when
   the generic pass under-performs. Clearly labeled demo scaffolding; deletable per site.
2. **Framework fingerprints:** detect once per page, then use framework-specific signals —
   Material-UI literally names components in classes (`MuiCard-root`, `MuiTypography-h1`,
   `MuiButton-root` → direct classification); Tailwind pages mark sections/prominence via
   utility patterns (`container`/`max-w-* mx-auto` wrappers, `py-16+` bands, `text-4xl+`
   headings, `grid`/`flex` with repeated children → collections).
3. **Semantic HTML:** `<section>/<header>/<main>/<article>/<footer>`, `h1–h3`, `<a>/<button>`,
   `<img>/<picture>/<video>`.
4. **Layout/computed-style heuristics** (the current fallback): type scale, viewport coverage,
   repeated sibling shapes.

Each node records which rung classified it (`via: "profile" | "framework" | "semantic" |
"layout"`) — visible in the overlay label during dev, so mis-classification is debuggable at a
glance, and honest in the demo ("generic pass got 80% of this page; the profile pinned the
rest").

**Node facts + ADA audit — extraction that *understands*, not just labels (pillar 1).** Every
node carries computed **facts**: line count ("wraps to 2 lines"), font size, WCAG contrast
ratio vs its effective background, truncation, focusability, missing alt. Three consumers:
1. **Display** — the overlay label and `ComponentCard` show them ("h1 · 2 lines · 48px ·
   contrast 8.2:1") — the visible proof we understand the page beyond drawing boxes.
2. **Constraints on generation** — the agent is told the facts and must respect them ("headline
   is 2 lines; keep it ≤2") — and the M3 warn layer flags regressions after apply: overflow,
   line-count growth, contrast dropping below WCAG AA, lost alt.
3. **The ADA audit** — a page-level rollup in the Page Brief (findings by path: low-contrast
   text, missing alts, broken heading hierarchy, unfocusable CTAs). It's both an insight ("this
   page ships 3 accessibility issues") and a variant opportunity: **a11y fixes are testable
   variants** the agent can propose.

**Addressing (load-bearing, do not simplify):** each node gets
`{ css: "#id | [data-*] | structural path", fingerprint: "first 40 chars normalized" }`.
Re-find requires the fingerprint to still match; **on mismatch: drop the op and report — never
guess.** Valid schema ≠ valid layout: constrained ops bound *what* the agent touches, they don't
guarantee rendering — that honesty stays in the demo script, and the verify loop (M7) is the fix.

### 4.3 The agent — loop in the browser
**One loop host, no abstraction layer:** Vercel AI SDK core (`ai` + `@ai-sdk/anthropic`) running
in the parent window, provider `baseURL` → `/api/anthropic` (a dumb key-holding proxy; the key
never reaches the client). Everything the agent touches already lives in the browser, so **tools
are plain async functions** — no server↔client tool bridge, no correlation ids, no session map.
`stopWhen: stepCountIs(16)`.

Auth decision (speed over subscription): **API key, not Claude-account OAuth.** The Agent SDK
subscription path needs a server-side session + SSE tool bridge — roughly a third of the backend
code for zero demo value. Demo usage costs a few dollars. Revisit post-MVP if at all.

Tools (each ~10 lines: zod schema + `sendToIframe` or store lookup):

| Tool | Answers from | Purpose |
|---|---|---|
| `list_components` | schema store | outline: ids, types, paths, one-liners |
| `read_component` | schema store | full slots/classes/rect of one node |
| `apply_op` | iframe | submit an `Op` — awaits human approval first |
| `revert_op` | iframe | undo an applied op |
| `create_variant` (M3) | variant store | save a recommendation as a named variant + activate it |
| `score_variant` | COM (§4.4) | rate the active variant — proposals return pre-scored |
| `save_memory` (M4) | memory API (§4.5) | replace the site memory doc with durable learnings |

Context strategy: system prompt + Page Brief + component *outline*; the agent reads full nodes on
demand (explores like Claude Code explores a repo — never receives the whole DOM). Human-in-the-
loop is just `apply_op`'s execute awaiting an approval promise the ProposalCard resolves.

**Chat rendering contract (requirement, not polish).** The chat is not a text stream — it renders
**rich blocks inline**, and the user can act on all of them by clicking or by replying:

| Block | Rendered when | Interaction |
|---|---|---|
| `ToolCallRow` | every tool call/result | expand to see args/result — the watchable-agent story |
| `BriefArtifact` | first turn | fields editable in place; edits update pinned context |
| `ComponentCard` | agent mentions/reads a component | click → highlight + scroll it in the preview; "ask about this" seeds the composer |
| `ProposalCard` | agent proposes an op | before/after slot diff + COM score badge + reasons; **Approve / Reject** buttons resolve `apply_op` |
| `VariantGallery` | agent renders it inline after saving variants; also on request | card per saved variant: best-effort thumbnail, COM delta, segment tag; click → switch preview |

Mechanism (thin, from the SDK): the loop streams typed message parts (text, tool call, tool
result); `MessageList` is a switch from part type → block component — no bespoke protocol.
Interaction is **bidirectional**: clicking a component in the *preview* inserts its path
(`hero.headline`) as a reference chip in the composer, so "pointing" and "talking" compose —
click the hero, type "make this about shipping speed", send.

### 4.4 The COM — independent verificator, deliberately rudimentary
A second model in its own context. `scoreVariant(control, variantOps, brief, goal)` → one
`generateObject` call (Haiku, through the same proxy) → it rates **both control and variant**
(0–1) against the brief (speaks to the ICP? addresses an unhandled objection? fills a proof
gap?) and reports the **delta** — unanchored single scores cluster around 0.7 and read as
arbitrary; the comparison is what carries information. Generator ≠ evaluator: the agent never sees the COM's rubric; the COM prompt states the
goal but never enumerates what "good" looks like. Honest framing: **zero traffic → this is a
prior, not conversion data**; real ranking is bandits over live users (out of scope; M9 simulates
the handoff). Swappable by design — `variant in → score out` is where a trained model slots in
later, and every `(brief, op, score, human verdict)` is logged as its future training data.

### 4.5 Site memory (M4, in the MVP) — a CLAUDE.md for the website
**Working memory (already here):** the messages array, the Page Brief pinned via the
rebuilt-per-turn system prompt, schema + op stores. Context-by-exploration is the discipline.

**Persistent site memory — file storage, Claude Code patterns.** A folder per site on disk,
through a trivial API:

```
.memory/<hostname>/
  memory.md     # agent-curated: durable learnings, taste rules, do-not-touch notes
  state.json    # app-managed: EVERYTHING extracted + decided —
                #   schema snapshot (components/paths/fingerprints) · seo · brief (ICP, pains,
                #   objections…) · goal · variant ops + scores · approve/reject verdicts
```

On reopen, LLM/human artifacts (brief, goal, ops, verdicts, memory) load as-is — never
regenerated. The structural schema re-extracts against the fresh DOM (it's free, deterministic,
and the live element map requires it); the **saved schema snapshot** then serves as prior +
change detector: fingerprints that moved or vanished get flagged ("pricing section changed since
last session") instead of silently trusted.

- `memory.md` is injected into the system prompt every turn (exactly like CLAUDE.md). The agent
  maintains it through a `save_memory` tool — called when it learns something durable ("their
  ICP responds to proof, not promises"; "never touch the compliance footer"). Approve/reject
  verdicts with reasons are auto-appended by the app.
- **Reopening the same URL resumes the project:** state.json rehydrates the brief and variant,
  memory.md rides in context — no re-extraction of understanding, the agent picks up where it
  left off. This is the reason memory is MVP, not polish: without it the demo resets every
  refresh.
- Demo beats: reject with a reason → next proposal respects it → reload → *still* respects it;
  and `memory.md` is a real file you can open on screen — the "CLAUDE.md for your website"
  moment — the product matures with each site it works on.

**Evals (M6, first post-MVP):**
1. **Harness smoke evals** (no LLM, per commit): ingest + extract against the validated 3-site
   set; assert hero found, slots non-empty, apply/revert round-trips.
2. **COM sanity suite** — the answer to "how do you know your judge isn't noise": ~6 fixture
   pairs with known ordering (obviously-better → positive delta, obviously-worse → negative,
   identical → delta ≈ 0, same-input stability across runs). Sign flip or drift = fail.
3. **The accruing eval set:** the `(brief, op, score, human verdict)` log in state.json is
   replayable — after any prompt change, check whether the COM agrees with past human verdicts
   more or less.

### 4.6 Export (M5, in the MVP) — the variant as a deployable A/B script
The arc must end in something you can run. **Export** produces one self-contained snippet:

- **Contents:** the variant's ops (JSON) + a small standalone applier (IIFE, dependency-free,
  same re-find rules as the runtime: `SelectorRef` + fingerprint against the ORIGINAL page —
  where fingerprints are valid — **drop-and-report on mismatch, never guess**).
- **It is an A/B test, not a patch:** in `ab` mode the applier assigns each visitor to
  `control` or `variant` (50/50, persisted in `localStorage`); in **`segment` mode** it applies
  the variant only when the segment's signal matches (UTM/query param, referrer, device class —
  rule-based, deterministic, no ML pretense). Either way it applies ops only for the targeted
  group, and
  exposes the assignment (`window.__overlayVariant` + a `data-overlay-variant` attribute) so
  the site's own analytics (GA4/PostHog/anything) can segment conversions. We deliberately do
  NOT measure — measurement belongs to the site's analytics; we make the assignment readable.
- **Two deployment paths:** (1) copy/paste a `<script>` tag before `</body>` — the "one script
  you install" model, for real; (2) the same snippet is edge-injectable (documented example:
  rewrite `</body>` in a Cloudflare Worker / Vercel Edge Middleware) — post-MVP to *document*,
  zero extra code to *enable*, since the snippet is identical.
- **Instant sanity path:** pasting the snippet into the browser console on the original live
  page applies the variant immediately (forced `variant` bucket) — the acceptance test and the
  quickest demo of "this leaves the tool."

### 4.7 Post-MVP mechanisms (specified so we don't improvise later)
- **Verify loop (M7):** after apply → overflow/clipping + layout-shift + WCAG contrast checks in
  the runtime; failures return to the agent → revise → retry (max 2) → proof note on the op. No
  unverified op reaches `applied` once this ships.
- **New sections (M8): clone-and-fill, not free generation.** Deep-clone the nearest donor
  pattern already on the page; agent only fills typed slots; a11y enforced at fill time (heading
  hierarchy, alt, focusable CTAs). Squeezes the parameter space; on-brand by construction.
- **Bandit sim (M9):** Thompson-sampling simulation over synthetic traffic showing how the COM
  prior seeds a bandit that then learns from (synthetic) conversions.
- **Variant server + autonomous loop (M10, north star):** saved variants (already in site
  memory) get **served dynamically** — `/api/serve/<site>.js` returns the same applier with ops
  fetched from the store, so a site installs ONE static script tag and variants update without
  re-pasting. On top: autonomous mode — the agent **generates variants on its own** (anchored
  to brief + memory), the COM pre-filters which deserve traffic, bucketing assigns visitors,
  and conversion signal feeds the bandit (M9's sim, made real). Deliberately enabled by M5's
  design: the static snippet and the served script are the same mechanism — the north star is
  a serving change, not a rewrite.

---

## 5. Data model (`lib/types.ts` — single source of truth, use verbatim)

```ts
type NodeType = "hero" | "section" | "card" | "collection" | "text" | "media" | "link";
type TextVariant = "h1" | "h2" | "h3" | "p" | "label";

interface SelectorRef { css: string; fingerprint?: string }

interface PageNode {
  id: string;                     // "n12"
  path: string;                   // "hero.headline" — chat/agent/op addressing
  type: NodeType;
  variant?: TextVariant;
  selector: SelectorRef;
  rect: { x: number; y: number; w: number; h: number };
  slots: Record<string, { kind: "text" | "media" | "link"; text?: string; href?: string;
                          src?: string; alt?: string }>;
  facts?: {                       // computed at extract — pillar 1's "we understand" layer
    lines?: number;               // text wrap count (rect height / line-height)
    fontPx?: number;
    contrast?: number;            // WCAG ratio vs effective background (walk up for bg)
    truncated?: boolean;
    focusable?: boolean;          // links/CTAs
    missingAlt?: boolean;         // media
  };
  classes: string[];              // captured so variants inherit them
  children?: string[];
}

// MVP op = update-content only. "collection-edit" and "add-section" join in M8.
type Op = { op: "update-content"; target: string /* node id */;
            slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }>;
            rationale: string };

interface VariantOp { id: string; source: "human" | "agent"; op: Op;
                      status: "pending" | "applied" | "rejected" | "failed"; }

interface Variant { id: string; name: string;   // "Pain-point hero" — agent- or human-named
                    goal: string; segment?: string; // aimed at a brief segment (B/personalization)
                    ops: VariantOp[]; score?: ComScore }
// The app holds Variant[] + activeId ("control" | variant id). Ops always record prevSlots
// vs CONTROL; switching tabs = revert all applied ops → replay the selected variant's list.

interface ComScore { control: number; variant: number; delta: number;   // scores BOTH — the
                     confidence: number; reasons: string[] }            // delta is the story

interface PageBrief {
  seo: { title: string; metaDescription?: string; og: Record<string, string>;
         headingOutline: { level: 1 | 2 | 3; text: string }[] };
  icp: string; problemStatement: string; valueProp: string;
  painPoints: { addressed: string[]; missed: string[] };
  objections: { handled: string[]; unhandled: string[] };
  proofAudit: { present: string[]; missing: string[] };
  ctaAudit: { path: string; text: string; intentStage: string }[];
  a11yAudit: { path: string; issue: string }[];   // ADA rollup from node facts — deterministic,
                                                  // rendered in the brief; fixes = variant ideas
  segments: { name: string; signal: string }[];   // 2-3 audiences + a DETECTABLE signal each
                                                  // (utm/query param, referrer, device class)
  suggestedGoals: string[];
  tone: string; lang: string;     // brand language lives here — no separate BrandProfile object
}
```

## 6. Tech stack
Next.js 15 (App Router) · TypeScript strict · React 19 · `ai@6` + `@ai-sdk/anthropic@3`
(browser loop; Sonnet for the agent, Haiku for the COM) · `zod` · `zustand` ·
`node-html-parser` · `nanoid` · **UI: Tailwind v4 + shadcn/ui + Vercel AI Elements** (researched
decision, see below) — dark theme, orange accent via CSS variables. Dev-only: `esbuild` (bundles
`lib/runtime.ts` to the injectable string). **No other libraries.**
Runs locally (`pnpm dev`, no gate) and deploys to Vercel **behind the password gate** (TECH-SPEC §13). Env: `ANTHROPIC_API_KEY` + `APP_PASSWORD` (deployment only).

**UI kit decision (low-effort path to the §4.3 chat contract):** [AI Elements]
(https://github.com/vercel/ai-elements) is Vercel's own shadcn-based registry of AI chat
components — `Conversation`, `Message`, `Response` (streaming markdown), **`Tool` with
ToolHeader/Input/Output** (our `ToolCallRow`, prebuilt), `PromptInput` (composer),
`Suggestions` (our goal chips), `Reasoning`, `Sources`. Components are **copied into the repo**
via CLI (shadcn registry model) — fully editable, no runtime lock-in, and presentational enough
to feed from our zustand `ChatBlock` store instead of `useChat`. We hand-build only the three
domain blocks on shadcn primitives: `ProposalCard`, `BriefArtifact`, `ComponentCard`.
Runner-up: `assistant-ui` — stronger runtime/state management, but we already own state
(fullStream → zustand); adopting its runtime would fight our custom loop. If an AI Elements
component turns out to hard-require `useChat` context, keep its markup/styles and swap the data
source — the code lives in our repo.

## 7. Milestones — MVP = M1–M5. Every milestone = deliverable + a pass you can RUN.

This section is the unified vision decomposed into deliverables: **each milestone maps 1:1 to a
GitHub issue** (the issue's acceptance checklist = the pass below), and each issue maps 1:1 to
the PR that closes it, with recorded evidence per criterion (CLAUDE.md → Workflow).

A milestone is not done when the code exists; it's done when its **pass** succeeds. Passes are
cumulative — each milestone's pass re-runs the previous ones (they're cheap; regressions caught
same-day).

- **M1 — hero tracer.** *Deliverable:* chat + preview shell with the **front-door empty
  state** (URL input + "paste your URL — analysis takes about a minute"), ingest, hero
  detection, op pipeline, browser loop (build order §10). *Pass:* on `maxtechera.dev` — send the URL, get a
  mini-brief; say "change the copy, point the CTA at /demo"; approve the proposal card; the hero
  visibly changes in <500 ms and revert restores it. On a bot-walled URL: clear error in chat,
  no hang.
- **M2 — full extraction + overlay + Page Brief.** *Deliverable:* whole-page detection ladder,
  labeled overlay with `via` tags, paths, **node facts + ADA audit** (§4.2), editable brief
  artifact, goal chips, two-way click↔chat wiring. *Pass:* on all 3 test sites — overlay
  identifies hero + ≥3 sections + cards where they exist; `ComponentCard`/overlay show computed
  facts (lines · fontPx · contrast) that spot-check TRUE against devtools; the brief renders
  with every field grounded (no invented claims on spot check) including an ADA findings list
  derived from facts and 2–3 segments each with a detectable signal; click a preview component → reference chip appears; edit the ICP field →
  next agent turn reflects the edit.
- **M3 — variants + COM.** *Deliverable:* **multiple named variants** — `create_variant` tool,
  variant tabs (Control · A · B · +), switching reverts to control and replays the selected op
  list; per-op revert; `score_variant` wired, proposals pre-scored; a ranked **variant
  gallery** (card per variant: best-effort html2canvas thumbnail — styled fallback card is a
  pass — COM delta, segment tag; click switches the preview); and **warn-only regression checks** —
  after every apply, the runtime re-computes the target's facts and flags regressions on the
  op: overflow, line-count growth, contrast below WCAG AA, lost alt (no retries, no
  screenshots — the full verify loop stays M7; this is the honesty layer that protects the MVP
  demo). *Pass:* ask for "three different hero angles" on `posthog.com` — the agent creates 3
  named variants, each with pre-scored proposals whose reasons reference the brief; clicking
  tabs visibly switches the page between Control/A/B/C; the comparison ranks them by delta; an
  obviously-worse variant (ask for "vague and generic") scores a negative delta; an op with a
  3×-length headline gets the overflow + line-growth warning on its card.
- **M4 — site memory.** *Deliverable:* memory API + `.memory/<hostname>/` (persisting ALL variants),
  `save_memory` tool, memory in context, resume + stale-diff. *Pass:* reject a proposal with a
  reason → next proposal respects it → **quit the browser, reopen, same URL** → brief loads
  from disk without an LLM call, the agent's greeting references the learning, and
  `.memory/<hostname>/memory.md` contains it.

- **M5 — export (MVP closes here).** *Deliverable:* the variant as a deployable A/B script
  (§4.6): per-variant picker → ops JSON + standalone applier with 50/50 bucketing, assignment exposed for analytics.
  *Pass:* pick any saved variant in the Export block; paste the exported snippet into the browser console on the ORIGINAL live page (clean
  tab, no app) → variant applies (forced bucket); as a `<script>` tag → visitors bucket 50/50
  and `window.__overlayVariant` reads correctly; a segment-mode export applies ONLY when its
  signal matches (e.g. `?utm_source=x`); fingerprint mismatch → drop-and-report, never guess.

**MVP gate — full-experience E2E validation (run when M5 passes; this is also the demo
dry-run):** one scripted session per test site (`posthog.com`, `maxtechera.dev`, `astro.build`),
each covering the entire arc — URL → brief → goal chip → 2+ proposals → approve one, reject one
with a reason → score delta visible → reload → resume with all variants intact → switch tabs across them → **export the chosen one and
apply it on the original live page**. Plus the failure lap: a bot-walled URL and a page with no
detectable hero, both answered honestly in chat. **Record the best full run as a video** — it's
the demo insurance and the proof artifact. MVP is "complete" only when this gate passes on all
three sites without touching code between runs.

- **M6 — evals** (§4.5). *Pass:* `pnpm eval` runs extraction smoke tests on saved fixtures +
  the 6-case COM sanity suite, exit 0; a deliberately broken fixture fails it.
- **M7 — verify loop** (§4.7). *Pass:* an op that overflows its container gets auto-revised or
  surfaced as "needs human," with the check results attached.
- **M8 — structure ops** (§4.7). *Pass:* "add a social-proof section after the hero" on a page
  with a donor pattern → new section inherits classes, passes a11y fill rules, verified by M7.
- **M9 — bandit sim** (§4.7). *Pass:* sim renders COM prior as starting weights → synthetic
  traffic → posterior visibly converging; labeled synthetic everywhere.

## 8. Cuts + honest limits (say these out loud)
Cut from MVP, deliberately: Claude-subscription auth (API key instead) · inline/manual editing
(agent edits + approve only) · side-by-side simultaneous preview (variants compare by switching
tabs + the ranked view, not split-screen iframes) · pre-flight report
(plain error messages instead) · BrandProfile extraction (tone/lang live in the brief) ·
card/collection mining (M8) · screenshots + viewport checks (M7) · MutationObserver re-apply
(static-page scope; hydrated sites may wipe patches — we say so) · 
eval suites (M6, first post-MVP). NOT cut: site memory — it's M4, inside the MVP, because
without it the demo resets on every refresh.
Standing limits: heuristic extraction misclassifies on messy sites; client-side apply only (no
SSR/SEO); proxy won't beat bot walls or auth walls; COM is a prior, not conversion data.
**Deployment:** public, but **password-gated** — a shared password (`APP_PASSWORD`) unlocks an
httpOnly cookie that every API route requires (un-gated, the key proxy and ingest route are open
to abuse). The exported snippet is unaffected — it's self-contained and calls no APIs. Locally,
no password set = no gate.

## 9. Why this shape (positioning)
- **Any site, no CMS** → proxy+inject = the "one script you install" deployment model that
  real optimization platforms use.
- **Variants as ops, human approves, scorer as signal-not-decider** → experimentation as the
  product motion, human-in-the-loop by construction; generator ≠ evaluator keeps the signal
  clean.
- **Built, not just driven** → thin loop host, everything around it hand-built: tool belt,
  context-by-exploration, approval gates, the surface the agent operates.
- **Clone-and-fill + op/verdict logging** → squeezed parameter space; the logs are the dataset
  you'd need to move toward one-shot on-brand generation.
- **Learned preferences + COM sanity suite** → per-brand taste that compounds per site, and a
  calibrated judge: the eval answers "is your scorer signal or noise" before it's asked.

## 10. M1 build order (each step runnable before the next; commit per step)

> Code-level contracts — pinned versions, exact APIs, complete proxy/tools/loop/runtime/prompt
> code, store shapes, UX choreography — live in **TECH-SPEC.md**. Build from that file.

```
app/page.tsx                     # two panes
app/api/ingest/route.ts          # §4.1
app/api/anthropic/[...p]/route.ts# ~15-line key proxy
app/api/memory/route.ts          # (M4) read/write .memory/<hostname>/
lib/{types,prompts,agent,com}.ts # types §5 verbatim · prompts · loop+tools · scoreVariant
lib/{runtime,profiles}.ts        # iframe side: extract (ladder §4.2)/apply/revert + postMessage
lib/store.ts                     # zustand: schema, chat, variant, approvals
components/{ChatPane,MessageList,PreviewPane,ProposalCard,ComponentCard,BriefArtifact}.tsx
components/ai-elements/          # installed via AI Elements CLI — editable source (§6)
```                              # MessageList = ChatBlock → AI Elements/custom block switch

1. **Shell:** two panes render; chat input echoes.
2. **Ingest:** iframe shows `maxtechera.dev` visually intact through the proxy.
3. **Handshake:** runtime posts `ready` → parent sends `extract` → hero node returned → overlay
   box drawn. Hero heuristic: most prominent heading in top 120% of viewport (largest computed
   font-size among h1/h2/[role=heading], first wins ties) with a link/button descendant; hero =
   nearest ancestor ≥60% viewport width; slots = headline / subhead (≤300 chars, optional) / cta.
   No candidate → empty schema; the agent must say so, not pretend.
4. **Op pipeline sans agent:** hardcoded button applies + reverts an `update-content` on the
   headline. Apply = re-find selector (fingerprint must match, else `refind-failed`) → set
   textContent/href; keep `{opId, prevSlots}` for revert. Never touch classes/structure.
5. **Loop:** agent turn streams with `read_component` + `apply_op`; `MessageList` renders text
   parts + `ToolCallRow`s live; apply_op awaits the ProposalCard's approve.
6. **The tick:** URL → mini-brief → instruction → pre-scored proposal → approve → hero changes
   live. Demo it end-to-end. M1 done.

Builder rules: interfaces from §5 verbatim · no libraries beyond §6 (UI comes from AI Elements /
shadcn — never hand-roll chat scaffolding) · tools return JSON/strings, never
throw across postMessage · every postMessage carries a `requestId` with a pending-map in
`IframeHost` · keys only in `app/api/**`.

---

## 11. Hard parts — verified, with prepared solutions

Every place this build can actually hurt, with the solution decided **now** so the builder never
improvises. The two riskiest assumptions are **already validated by spikes** (results in
TECH-SPEC §10/§12): the pass-through proxy renders the test set
near-pixel-perfect with our script injected and the DOM readable, and a multi-step tool loop
streams through that proxy cleanly on the pinned `ai@6` APIs.

| # | Hard part | Prepared solution |
|---|---|---|
| 1 | **Loop + proxy streaming.** Multi-step tool streaming is known to break through protocol-*translating* proxies (LiteLLM-class bugs). | Proxy is a **byte-level pass-through** (never parse or re-emit SSE). ✅ **Validated**: `scripts/step0-spike.mjs` ran a 2-step tool loop through it green; `scripts/spike-shots.mjs` validated ingest fidelity on all three test sites. Residual: re-confirm once from an actual browser tab during §10 step 5 (expected no-op — browser fetch streams SSE the same way). |
| 2 | **Human approval mid-loop.** | Primary: `apply_op.execute` awaits an approval promise the ProposalCard resolves — trivial *because* loop and UI share a process; no timeout needed (user is present). **Reject must resolve, not throw**: return `{ applied: false, reason: "rejected by user" }` so the model continues gracefully. Native `needsApproval: true` is the documented alternative if we ever move the loop server-side — don't use both. |
| 3 | **Transcript without `useChat`.** `useChat` assumes a server chat endpoint; we don't have one. | Consume `result.fullStream` directly. Handle exactly four part types: `text-delta` (append to current text block), `tool-call` (open a `ToolCallRow` / `ProposalCard` keyed by `toolCallId`), `tool-result` (close it), `error`. Ignore the rest (observed full list in TECH-SPEC §0). Push into the zustand chat store; batch text-deltas with `requestAnimationFrame`. This IS the §4.3 rendering contract's implementation — no extra protocol. |
| 4 | **Multi-turn memory.** No server session to lean on. | Keep `messages: ModelMessage[]` in the store; after each turn append `(await result.response).messages` (includes tool calls/results). The Page Brief is NOT a message — it's interpolated into the system prompt, rebuilt each turn from the store (so human edits to the brief take effect on the next turn automatically). |
| 5 | **Fingerprints self-invalidate.** After we change the hero headline, its text fingerprint no longer matches — the next op or revert on that node would fail our own re-find rule. | Two-tier addressing: at extract time the runtime keeps a live `Map<nodeId, Element>` — **all in-session ops/reverts resolve through the element map**, never re-query. `SelectorRef` + fingerprint are only for re-attach after reload and for the export snippet (which runs against the *original* page, where fingerprints are valid). |
| 6 | **Sites whose JS fights us.** Hydration re-render can wipe patches; the page's own `fetch`es now cross-origin (we serve from our origin) and may fail. | Accepted, scoped, and worded in chat: MVP is static-ish pages (tier 1); on tier 2 the *server-rendered HTML* renders fine and text ops work on first paint — if the site's JS later reverts a patch, the runtime detects it (element's textContent ≠ op value on a 1s check) and reports `op-wiped` so the agent/user sees truth. No MutationObserver re-apply in MVP. |
| 7 | **Hero detection variance.** One heuristic won't fit all pages. | The §4.2 detection ladder (per-site profiles → framework fingerprints → semantic → layout) + a hard rule: **empty result is a valid result** — the agent says "couldn't identify a hero" instead of guessing. Tune against the canonical test set only (posthog.com · maxtechera.dev · astro.build); resist tuning against the world. |
| 8 | **COM independence in one process.** | Independence = context separation, not infrastructure: `com.ts` exports one function, own system prompt, **zero shared messages** with the agent loop; the agent only ever sees the returned `ComScore` JSON via the tool result. Enforced by a lint-level rule: `com.ts` imports nothing from `agent.ts`/store. |
| 9 | **Anthropic browser CORS.** Provider called from a page, not Node. | Non-issue by construction: requests go same-origin to `/api/anthropic/*`; the browser never talks to Anthropic. No `anthropic-dangerous-direct-browser-access`, no CORS headers needed. |

With both spikes green, hard parts 1–5 and 9 are architecture-solved and just need the code
written to this spec; 6–8 are scoped judgment calls already made above.
