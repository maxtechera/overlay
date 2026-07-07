# CLAUDE.md — Overlay agent operating manual

You are one of several agents building Overlay in the open. This file is the team's shared
contract; read it fully before touching anything.

## Source of truth (in order)
1. **TECH-SPEC.md** — how to build. §0 version pins are law (they were hit for real: `ai@6` +
   `@ai-sdk/anthropic@3`, never @4/ai@7). Interfaces in PRD §5 are used verbatim.
2. **PRD.md** — what and why. §7 defines every milestone's *pass*; §10 the M1 build order;
   §11 the pre-solved hard parts. Do not re-decide decided things.
3. This file — team workflow + durable learnings.

## Workflow (issue-driven)
- Work = GitHub issues (`gh issue list`). One issue at a time; comment that you're taking it.
- Branch `m<N>-<slug>` off master. One commit per §10 build step or coherent unit.
- **A milestone is done when its PASS runs green, not when code exists.** Passes are cumulative:
  re-run earlier ones before opening a PR.
- PR must include **evidence**: the pass's observable result (terminal output, screenshot, or
  short recording) + which PRD/TECH-SPEC sections it implements. Reference the issue.
- Never merge red. Never weaken a pass to make it green — fix the code or raise it on the issue.

## Hard rules
- No dependencies beyond PRD §6. UI comes from AI Elements/shadcn — never hand-roll chat
  scaffolding.
- Secrets only in `.env.local` (gitignored), read only in `app/api/**`. Never commit keys,
  never log them.
- `.memory/` is app data (site memory) — gitignored, never committed.
- `lib/runtime.ts` stays dependency-free (it runs inside third-party pages).
- Tools return JSON/strings; never throw across postMessage; every postMessage carries a
  `requestId`.
- `lib/com.ts` imports nothing from `agent.ts` or stores (generator ≠ evaluator).
- Tune extraction/prompts ONLY against the test set: `posthog.com` · `maxtechera.dev` ·
  `astro.build` (failure-lap: `linear.app`, bot-walled). `scripts/*.mjs` are validation evidence — keep them working.
- Don't edit PRD.md/TECH-SPEC.md unilaterally: propose the change on the issue, then a
  docs-only PR.

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
