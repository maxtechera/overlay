# CONTEXT.md — ubiquitous language

One term, one meaning. If a doc, issue, or PR uses these words differently, the doc is wrong —
fix it or challenge this glossary in a PR.

## The two pillars
- **Understand** — pillar 1: deterministic extraction of a live page: design system, components,
  patterns, node facts, ADA audit. No LLM in extraction, ever.
- **Generate** — pillar 2: variants that are *validated* (constrained ops), *verified* (checked
  with evidence), *CRO-optimized* (brief-anchored, independently scored).

## Page understanding
- **PageNode** — one extracted element: id, human `path`, `type`, `SelectorRef`, `slots`,
  `facts`, `via`. Defined in PRD §5, verbatim in `lib/types.ts`.
- **Component** — a container-type PageNode: `hero | section | card | collection`. What the
  outline lists and ops target.
- **Leaf-node rule** — `text|media|link` nodes exist ONLY for orphan content no container
  claimed; content inside a container is its **slots**, not separate nodes.
- **Slot** — a typed content position inside a node (`text` / `media` / `link` values). The ONLY
  thing `update-content` ops may change.
- **Facts** — computed, per-node: `lines`, `fontPx`, `contrast`, `truncated`, `focusable`,
  `missingAlt`. Displayed on cards, enforced as generation constraints, rolled up into the ADA
  audit.
- **ADA audit** — deterministic page-level rollup of fact violations (`{path, issue}[]`). The
  LLM narrates it; it never invents findings.
- **Detection ladder** — classification order: profile → framework → semantic → layout. Recorded
  per node as `via`.
- **Profile** — per-hostname selector overrides (`lib/profiles.ts`); bootstrap scaffolding, deletable per site.
- **SelectorRef / fingerprint** — css selector + normalized text prefix; re-find requires the
  fingerprint to match. **Drop-and-report on mismatch, never guess.** In-session ops use the
  live element map instead (fingerprints self-invalidate after our own edits).
- **Page Brief** — the agent's first-turn artifact: SEO, ICP, problem/value, pain points,
  objections, proof/CTA audits, ADA audit, suggested goals, tone/lang. Human-editable; pinned
  into the system prompt every turn; never a chat message.

## Variants
- **Control** — the page as extracted. Read-only truth.
- **Variant** — a NAMED, ordered list of VariantOps against control (optionally aimed at a
  segment). Replay from control = the variant. The MVP holds many; switching tabs = revert all
  + replay the selected list.
- **Op** — a typed change: `update-content` (MVP); `collection-edit`, `add-section` (M8).
- **VariantOp** — an Op + `source: human|agent` + status (`pending|applied|rejected|failed`).
- **Proposal** — a pending agent VariantOp awaiting approval, rendered as a **ProposalCard**
  (slot diff + COM score + Approve/Reject). Not a separate type.
- **Warn-only regression checks (M3)** — post-apply fact re-computation: overflow, line growth,
  contrast < AA, lost alt → `warnings` on `op-applied`. Warns, never blocks; the blocking
  **verify loop** is M7.
- **Experiment** — a named, component-targeted test proposal ("<Component> — <Change idea>")
  with a brief-grounded hypothesis; its **arms** are variants (`experimentId`), control
  implicit. Status: proposed → building → ready → exported.
- **Experiment Plan** — the agent's backlog: 6–10 proposals rendered as actionable cards
  ("Build arms"). Every targetPath must exist in the schema — validated app-side.
- **Suggested allocation** — COM-PRIOR traffic split shown on built experiments (control 25%
  fixed, 75% ∝ arm deltas). A suggestion, never a measurement; the real bandit is M9/M10.
- **Segment** — one of 2–3 audiences the brief identifies, each with a *detectable* signal
  (UTM/query param, referrer, device class). A variant may be aimed at a segment.
- **Variant gallery** — the comparison surface: one card per saved variant (best-effort
  thumbnail, COM delta, segment tag); clicking switches the preview.
- **Export / snippet (M5)** — the variant as a standalone A/B script: ops JSON + applier. Two
  modes: `ab` (50/50 **bucket**, persisted per visitor) or `segment` (applies only when the
  segment's signal matches — rule-based). Assignment exposed as `window.__overlayVariant`;
  we never measure — the site's analytics reads it.

## Judgment
- **COM (Conversion Optimization Model)** — the independent verificator. Separate context,
  imports nothing from the agent, scores **control AND variant** → the **delta** is the story.
  A prior, not conversion data.
- **Generator ≠ evaluator** — the agent never sees the COM's rubric; the COM never sees the
  agent's reasoning.

## Memory & process
- **Project context** — `context.md`: USER-authored, per-site ("launching in August, goal =
  trial signups, never touch pricing"), UI-editable, injected every turn. The user defines the
  project; the agent works inside it.
- **Site memory** — `.memory/<hostname>/`: `context.md` (user-authored) + `memory.md`
  (agent-curated durable knowledge — the CLAUDE.md pattern) + `state.json` (app-managed:
  schema snapshot, seo, brief, goal, experiments, variants, verdicts).
- **Approval mode** — `ask` (default: every op awaits the ProposalCard) or `auto` (ops apply
  immediately, still recorded + revertible). Claude Code's permission model on page edits.
- **Resume** — reopen same URL: LLM/human artifacts hydrate from disk (never regenerated);
  structure re-extracts fresh; saved schema diffs by path+fingerprint → **stale** nodes flagged.
- **Milestone / pass** — a milestone is done when its runnable pass (PRD §7 = the issue's
  acceptance checklist) goes green. 1 milestone ↔ 1 issue ↔ 1 PR.
- **Harness** — CI-enforced workflow: `@mN`-tagged Playwright specs, screenshot+video artifacts
  on every PR, harness-lint (code PRs must touch `e2e/`).
