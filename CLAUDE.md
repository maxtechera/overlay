# CLAUDE.md — Overlay agent operating manual

You are one of several agents building Overlay in the open. This file is the team's shared
contract; read it fully before touching anything.

## Source of truth (in order)
1. **TECH-SPEC.md** — how to build. §0 version pins are law (they were hit for real: `ai@6` +
   `@ai-sdk/anthropic@3`, never @4/ai@7). Interfaces in PRD §5 are used verbatim.
2. **PRD.md** — what and why. §7 defines every milestone's *pass*; §10 the M1 build order;
   §11 the pre-solved hard parts. Do not re-decide decided things.
3. This file — team workflow + durable learnings.

## Shared context & memory (how a team of agents stays coherent)
- **Shared context** = this repo: PRD.md (the unified vision — every §7 milestone maps to a
  small set of fine-grained issues), TECH-SPEC.md (contracts), this file (workflow + learnings). Read all
  three before working; never rely on private context another agent can't see.
- **Shared memory** = two layers: durable → the Learnings section below (one line per gotcha,
  added in the PR that hit it); situational → issue/PR comments (searchable by every agent).
  If you learned it and it's not written in one of those places, the team doesn't know it.

## Workflow (issue-driven, one-to-one)
- Work = GitHub issues, sliced fine-grained for parallel delegation (a milestone may span a
  small set of issues; its PRD §7 pass = the union of their checklists). **One issue ↔ one PR,
  exactly** (`Closes #N` in the PR body). No
  drive-by changes outside the issue's scope; found something else? Open a new issue.
- Comment on the issue when you take it. Branch `m<N>-<slug>` off master. One commit per §10
  build step or coherent unit.
- **A milestone is done when its PASS runs green, not when code exists.** The issue's
  acceptance checklist IS the pass. Passes are cumulative: re-run earlier milestones' specs
  before opening a PR.
- **Every PR must carry evidence mapped to the acceptance criteria**: for EACH checklist item
  on the issue, the PR description states how it's proven — a `@mN` e2e spec name + the CI
  screenshot/video artifact, or a terminal output for non-visual items. Snapshots are not
  optional; CI records them on every test and harness-lint enforces specs exist.
- Never merge red. Never weaken a pass or a spec to make it green — fix the code or raise it
  on the issue.

## Hard rules
- No dependencies beyond PRD §6. UI comes from AI Elements/shadcn — never hand-roll chat
  scaffolding.
- Secrets only in `.env.local` (gitignored), read only in `app/api/**`. Never commit keys,
  never log them.
- **Deploy only behind the password gate.** Un-gated, `/api/anthropic` is an open proxy to the
  key and `/api/ingest` a free fetcher. Public deployments require `APP_PASSWORD` set and the
  cookie gate active on every API route (TECH-SPEC §13, issue #12). Locally, unset
  `APP_PASSWORD` = no gate. Never deploy as a side effect of closing a milestone.
- `.memory/` is app data (site memory) — gitignored, never committed.
- `lib/runtime.ts` stays dependency-free (it runs inside third-party pages).
- Tools return JSON/strings; never throw across postMessage; every postMessage carries a
  `requestId`.
- `lib/com.ts` imports nothing from `agent.ts` or stores (generator ≠ evaluator).
- Tune extraction/prompts ONLY against the test set: `posthog.com` · `maxtechera.dev` ·
  `astro.build` (failure-lap: `linear.app`, bot-walled). `scripts/*.mjs` are validation evidence — keep them working.
- Don't edit PRD.md/TECH-SPEC.md unilaterally: propose the change on the issue, then a
  docs-only PR.

## AFK orchestration (fire-and-forget delivery — baked into `.claude/agents/`)

Milestones are delivered autonomously by a three-role loop. Models are fixed by role:

- **Orchestrator — Fable.** Owns the board; never implements. Loop: pick the next issue per the
  dependency lanes (PRD handoff block) → spawn an `overlay-worker` → when its PR is up, spawn an
  `overlay-advisor` review → drive the fix loop (worker addresses BLOCKERS; max 2 review
  rounds) → **merge only when** CI green (typecheck · e2e · harness-lint) AND every acceptance
  item has evidence AND advisor verdict = approve → squash-merge, close issue, append any
  Learnings, pick the next issue. Runs parallel lanes only where the graph allows; never two
  workers on overlapping files.
- **Workers — Sonnet (`overlay-worker`).** One issue → one branch → one PR with per-criterion
  evidence. Full harness compliance. They never merge and never pick their own work.
- **Advisor — Fable (`overlay-advisor`).** Consulted mid-issue for hard calls; adversarial
  review before EVERY merge (generator ≠ evaluator applies to code too). Read/run only.

**AFK stop conditions** (halt the lane, write a handoff comment on the issue, move to an
independent lane if one exists): a pass won't go green after 3 distinct approaches · a spec
would need weakening · a missing dependency or secret · one issue burning wildly beyond its
size (spend anomaly). The board never advances past a red gate; nothing is ever force-merged.

**Kickoff order** (current board): #1 and #15 immediately (independent); when #1 merges →
#13 ∥ #2; then #14 → #3 → #4 → #10 → gate #5. #12 any time after #13.

## The harness (CI-enforced — this is how we build)
- **Every milestone pass is executable.** Encode it as Playwright specs in `e2e/`, tagged
  `@m1`…`@m8` (+ `@smoke` for keyless always-run checks). `pnpm test:e2e` runs them. A milestone
  closes when its tagged specs go green — not when someone says it's done.
- **Every PR ships visual evidence automatically.** Playwright records a screenshot AND video
  for every test (`playwright.config.ts`); CI uploads `test-results/` + `playwright-report/` as
  artifacts on every PR. Reference the artifact in your PR description.
- **AI-dependent specs** are tagged `@ai` and `test.skip` when `ANTHROPIC_API_KEY` is unset —
  CI may run keyless and must stay green.
- **harness-lint** (CI) fails any PR that touches `app/`, `lib/`, or `components/` without
  touching `e2e/`. No code without tests. Maintainers may apply the `harness-exempt` label for
  genuine exceptions (docs/config-only).
- Required to merge: typecheck + e2e + harness-lint, all green. Never weaken a spec to pass it —
  fix the code or raise it on the issue.

## Team memory
- Durable discoveries (gotchas, API surprises, decisions) go in **this file** under Learnings
  via the same PR that hit them — one line each, link the PR.
- Ephemeral context (what you tried, why you chose X) lives in issue/PR comments — searchable,
  not in context.

## Learnings (append-only, one line each)
- 2026-07-07 `@ai-sdk/anthropic@4` is ai@7-only → `UnsupportedModelVersionError`; pin @3 (step0 spike).
- 2026-07-07 `text-delta` parts carry `.text` not `.delta` (vercel/ai#8756) — read both.
- 2026-07-07 a validation-set site ran its own A/B optimizer, rotating its hero mid-session → ingest strips third-party experiment scripts.
- 2026-07-07 `<base href>` alone resolves all relative/root-relative URLs — no absolutization pass; but it makes every link click navigate away → runtime click interceptor is mandatory.
