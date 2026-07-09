/**
 * e2e/m4-memory.spec.ts
 * M4/#4 acceptance checklist (TECH-SPEC §11 / PRD §4.6).
 *
 * Every KEYLESS item below runs on every CI PR, no ANTHROPIC_API_KEY needed:
 *  - .memory/<hostname>/memory.md exists after a save, openable in an editor
 *  - resume hydrates the brief from disk with ZERO brief-generation LLM calls
 *  - saved variants + ops survive reopen (tabs repopulate); re-apply works on a non-stale
 *    target and refuses (never guessing) on a stale one
 *  - path-safety: a traversal `site` is rejected
 *  - the reject-reason mechanism (buildSystem()'s recent-verdicts section) is a pure function
 *    of store state — proven directly, no model needed
 *
 * The two items that genuinely need a live model — "reject with a reason -> the model's NEXT
 * proposal respects it" and "the greeting references what it knows" — are written below as
 * @ai specs that test.skip cleanly without ANTHROPIC_API_KEY (CLAUDE.md harness rule), same
 * pattern as e2e/m1b-agent-tick.spec.ts / m2b-artifacts.spec.ts / m3-variants.spec.ts.
 *
 * Tune target: maxtechera.dev only (CLAUDE.md) — the only site these specs touch `.memory/`
 * for; the memory-mutating tests below run test.describe.serial so they never race each other
 * over the same `.memory/maxtechera.dev/` folder.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildSystem } from "../lib/prompts";
import { useMemoryStore, useSessionStore, useSchemaStore } from "../lib/store";
import type { MemoryState } from "../lib/memory";
import type { PageNode } from "../lib/types";

test.beforeEach(({}, testInfo) => {
  if (testInfo.tags.includes("@ai") && !process.env.ANTHROPIC_API_KEY) {
    testInfo.skip();
  }
});

const MEMORY_ROOT = join(process.cwd(), ".memory");

async function submitAndWaitForExtraction(page: Page, url = "https://maxtechera.dev") {
  await page.goto("/");
  await page.getByTestId("url-input").fill(url);
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({
    timeout: 30_000,
  });
}

function minimalNode(overrides: Partial<PageNode>): PageNode {
  return {
    id: "n-fixture",
    path: "fixture",
    type: "section",
    selector: { css: "body" },
    rect: { x: 0, y: 0, w: 100, h: 100 },
    slots: {},
    classes: [],
    ...overrides,
  };
}

// ── 1 · save_memory persists a real, readable file (keyless) ───────────────────────────

test("1 · save_memory tool call writes .memory/<hostname>/memory.md, readable back verbatim @m4", async ({
  page,
}) => {
  const site = `m4-savefile-${test.info().workerIndex}.example`;
  const content = `# Learnings\n- ICP responds to proof, not promises\n- never touch the compliance footer\n(worker ${test.info().workerIndex})`;

  await page.goto("/");
  await page.evaluate(
    async ({ site, content }) => {
      const sessionStore = (window as unknown as { __overlaySessionStore: { getState: () => { setUrl: (u: string) => void } } })
        .__overlaySessionStore;
      sessionStore.getState().setUrl(`https://${site}`);
      const makeTools = (window as unknown as { __overlayMakeTools: (deps: { send: unknown }) => { save_memory: { execute: (a: { content: string }) => Promise<unknown> } } })
        .__overlayMakeTools;
      const tools = makeTools({ send: async () => ({ t: "op-applied", opId: "x", ok: true }) });
      await tools.save_memory.execute({ content });
    },
    { site, content }
  );

  // Give the fire-and-forget POST a moment to land, then read the file straight off disk —
  // proving it's a REAL file (openable in an editor), not just an in-memory store value.
  await expect
    .poll(() => existsSync(join(MEMORY_ROOT, site, "memory.md")), { timeout: 5_000 })
    .toBe(true);
  const onDisk = readFileSync(join(MEMORY_ROOT, site, "memory.md"), "utf-8");
  expect(onDisk).toBe(content);
});

// ── 2 · path-safety (keyless) ───────────────────────────────────────────────────────────

test("2 · GET /api/memory?site=../../etc is rejected @m4", async ({ page }) => {
  await page.goto("/");
  const res = await page.request.get("/api/memory?site=../../etc");
  expect(res.status(), "a traversal site must never 200").not.toBe(200);
  expect(res.status()).toBe(400);
});

test("2b · a bare '..' site (passes the char-class regex, still traversal) is rejected @m4", async ({ page }) => {
  // ".." matches /^[a-z0-9.-]+$/i (both chars are in the class) — the explicit ".." substring
  // check in app/api/memory/route.ts's siteDir() is what catches this one.
  await page.goto("/");
  const res = await page.request.get("/api/memory?site=..");
  expect(res.status()).toBe(400);
});

test("2c · POST with a traversal site is rejected too @m4", async ({ page }) => {
  await page.goto("/");
  const res = await page.request.post("/api/memory", { data: { site: "../etc", memory: "pwned" } });
  expect(res.status()).toBe(400);
});

// ── 3 · buildSystem() unit-level proof: memory content + verdict reasons are ALWAYS in the
//        prompt (keyless) — the mechanism the (deferred @ai) "reject with a reason -> next
//        proposal respects it" acceptance item depends on. lib/prompts.ts's buildSystem is a
//        pure function of store state (no DOM, no network) — importable directly here. ────

test("3 · buildSystem() includes memory.md content and recent verdict reasons every turn @m4", () => {
  useSessionStore.getState().setUrl("https://build-system-unit-test.example");
  useSchemaStore.setState({ nodes: {}, order: [], seo: null, a11yAudit: [] });
  useMemoryStore.getState().reset();
  useMemoryStore.getState().setContent("- never touch the compliance footer");
  useMemoryStore.getState().addVerdict({
    opId: "op-1",
    approved: false,
    reason: "too salesy for this audience",
    at: Date.now(),
  });

  const system = buildSystem();
  expect(system).toContain("never touch the compliance footer");
  expect(system).toContain("Recent approve/reject verdicts");
  expect(system).toContain("rejected: too salesy for this audience");

  // Second call (simulating the NEXT turn) still carries it — "reload -> *still* respects it"
  // (PRD §4.6) starts from this: the verdict is store state, not a one-shot message.
  expect(buildSystem()).toContain("too salesy for this audience");
});

test("3b · buildSystem() reports 'none yet' with an empty memory + no verdicts section @m4", () => {
  useSessionStore.getState().setUrl("https://build-system-unit-test-2.example");
  useSchemaStore.setState({ nodes: {}, order: [], seo: null, a11yAudit: [] });
  useMemoryStore.getState().reset();

  const system = buildSystem();
  expect(system).toContain("none yet");
  expect(system).not.toContain("Recent approve/reject verdicts");
});

// ── 4 · resume — brief hydrates from disk with ZERO brief-generation LLM calls (keyless) ──

test.describe.serial("resume (mutates .memory/maxtechera.dev/ — serialized)", () => {
  test("4 · reopen a known URL -> brief loads from disk instantly, no streamObject/generateObject call fires @m4", async ({
    page,
  }) => {
    const seededBrief = {
      seo: { title: "seed-title", og: {}, headingOutline: [] },
      icp: "MARKER-ICP-zorblax-procurement-officers",
      problemStatement: "seed problem statement long enough to render",
      valueProp: "seed value proposition long enough to render",
      painPoints: { addressed: [], missed: [] },
      objections: { handled: [], unhandled: [] },
      proofAudit: { present: [], missing: [] },
      ctaAudit: [],
      a11yAudit: [],
      segments: [],
      suggestedGoals: ["seed goal"],
      tone: "",
      lang: "en",
    };
    const seededState: MemoryState = {
      schema: { nodes: [], extractedAt: Date.now() },
      seo: seededBrief.seo,
      brief: seededBrief,
      goal: "seed goal",
      experiments: [],
      variants: [],
      verdicts: [{ opId: "op-seed", approved: true, reason: "seed verdict", at: Date.now() }],
    };

    await page.goto("/");
    const seedRes = await page.request.post("/api/memory", {
      data: { site: "maxtechera.dev", memory: "- seeded learning A\n- seeded learning B", state: seededState },
    });
    expect(seedRes.ok()).toBe(true);

    // Intercept every call to the Anthropic proxy; a brief/plan (streamObject/generateObject)
    // request NEVER carries a `tools` array (only the agent LOOP's requests do — same
    // discrimination e2e/m2b-artifacts.spec.ts test 5 uses) — so "zero non-tool-bearing
    // requests" is precisely "zero brief-generation calls", regardless of whether the (normal,
    // @ai, unrelated-to-this-assertion) greeting chat turn also fires one.
    const nonAgentLoopCalls: unknown[] = [];
    await page.route("**/api/anthropic/v1/**", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { tools?: unknown[] };
      if (!Array.isArray(body.tools)) nonAgentLoopCalls.push(body);
      await route.abort();
    });

    await page.getByTestId("url-input").fill("https://maxtechera.dev");
    await page.getByRole("button", { name: /analyze/i }).click();
    await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({
      timeout: 30_000,
    });

    // The brief must render basically instantly — hydrated synchronously from disk in
    // handleSubmit, well BEFORE extraction even starts, let alone a streamObject call.
    await expect(page.getByTestId("brief-artifact")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('[data-testid="brief-icp"]')).toHaveValue(seededBrief.icp);

    // Give any (incorrect) accidental brief-generation call time to fire before asserting zero.
    await page.waitForTimeout(2_000);
    expect(nonAgentLoopCalls.length, "resume must fire ZERO brief-generation calls").toBe(0);
  });

  // ── 5 · saved variants + ops survive reopen; re-apply works on non-stale, refuses on stale ──
  //
  // PR #41 review fixes baked in:
  //  - BLOCKER 1 (flaky in the full suite): the phase-1 page's own debounced autosave
  //    (persistState, subscribed to the stores) can race the phase-2 seed POST and clobber it
  //    with the live 43-node/0-variant extraction. Fix: navigate phase-1 to about:blank FIRST —
  //    that tears down its React tree + zustand subscriptions + any pending debounce timer —
  //    before seeding, so nothing is left alive to overwrite the fixture.
  //  - BLOCKER 2: assert the real, user-visible surface (ResumeOpsPanel's rows/buttons, the
  //    stale-sections note) as the PRIMARY proof — the store/hook reads below are secondary
  //    sanity checks, not the acceptance evidence.

  test("5 · saved variants/ops survive reopen (tabs repopulate); the visible 'from last session' panel re-applies a non-stale op and refuses (never guessing) a stale one @m4", async ({
    page,
  }) => {
    // Phase 1: a real, fresh extraction — capture the REAL current hero headline text so the
    // "non-stale" fixture node's fingerprint will genuinely match on the SECOND extraction.
    await submitAndWaitForExtraction(page);
    const heroFacts = await page.evaluate(() => {
      const schema = (
        window as unknown as {
          __overlaySchemaStore: { getState: () => { order: string[]; nodes: Record<string, PageNode> } };
        }
      ).__overlaySchemaStore.getState();
      const heroId = schema.order.find((id) => schema.nodes[id].type === "hero");
      if (!heroId) return null;
      return { headline: schema.nodes[heroId].slots.headline?.text ?? "" };
    });
    expect(heroFacts, "maxtechera.dev must have a hero to build this fixture against").toBeTruthy();

    // BLOCKER 1 fix: tear down phase-1's live page (and its debounced autosave subscriptions)
    // BEFORE seeding — otherwise a pending 400ms persistState timer can fire after our seed
    // POST lands and silently overwrite it with the real (unrelated) extraction state.
    await page.goto("about:blank");

    const savedHeroNode = minimalNode({
      id: "n-old-hero",
      path: "hero",
      type: "hero",
      slots: { headline: { kind: "text", text: heroFacts!.headline } },
    });
    const savedStaleNode = minimalNode({
      id: "n-old-stale",
      path: "vanished-section-from-last-session",
      type: "section",
      slots: { body: { kind: "text", text: "this section no longer exists" } },
    });

    const seededState: MemoryState = {
      schema: { nodes: [savedHeroNode, savedStaleNode], extractedAt: Date.now() },
      seo: null,
      brief: null,
      goal: "",
      experiments: [],
      variants: [
        {
          id: "v-resumed",
          name: "Resumed variant",
          goal: "",
          ops: [
            {
              id: "op-live",
              source: "agent",
              status: "applied",
              op: {
                op: "update-content",
                target: "n-old-hero",
                slots: { headline: { text: "Re-applied headline from last session" } },
                rationale: "swap the hero headline for a punchier one (from last session)",
              },
            },
            {
              id: "op-stale",
              source: "agent",
              status: "applied",
              op: {
                op: "update-content",
                target: "n-old-stale",
                slots: { body: { text: "should never apply" } },
                rationale: "edit the (now-vanished) section from last session",
              },
            },
          ],
        },
      ],
      verdicts: [],
    };

    const seedRes = await page.request.post("/api/memory", {
      data: { site: "maxtechera.dev", state: seededState },
    });
    expect(seedRes.ok()).toBe(true);

    // Immediately re-read it back to prove the seed actually landed (and wasn't itself raced
    // by something else) before moving on to phase 2 — a fast, cheap determinism guard.
    const verifySeed = await page.request.get("/api/memory?site=maxtechera.dev");
    const verifyBody = (await verifySeed.json()) as { state: MemoryState | null };
    expect(verifyBody.state?.variants.length, "seed must have landed with exactly 1 variant before phase 2").toBe(1);

    // Phase 2: a fresh page load ("quit the browser, reopen") + resubmit the same URL.
    await page.route("**/api/anthropic/v1/**", (route) => route.abort()); // keyless — no key needed at all
    await submitAndWaitForExtraction(page);

    // resumeSummary is set ONLY by the resume-diff code path, right after the SECOND
    // extraction settles — waiting for it proves this is genuinely the resumed run, not a
    // leftover DOM state from a previous test.
    await page.waitForFunction(
      () =>
        (window as unknown as { __overlayMemoryStore?: { getState: () => { resumeSummary: string | null } } })
          .__overlayMemoryStore?.getState().resumeSummary !== null,
      { timeout: 15_000 }
    );

    // ── PRIMARY proof: the real, visible surface ──────────────────────────────────────────

    // "ALL saved variants survive reopen (tabs repopulate)" — in the DOM, not just the store.
    await expect(page.getByTestId("variant-tab")).toHaveCount(1);

    // "the op list shows 'from last session'" — ResumeOpsPanel renders one row per hydrated op.
    await expect(page.getByTestId("resume-ops-panel")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("resume-op-row")).toHaveCount(2);

    // Stale nodes are marked visibly in the outline/status area (not hook-only).
    await expect(page.getByTestId("stale-sections-note")).toBeVisible();
    await expect(page.getByTestId("stale-sections-note")).toContainText("vanished-section-from-last-session");
    // "hero" is NOT a substring of "vanished-section-from-last-session" — a plain substring
    // check is enough to prove the unchanged hero path was correctly excluded.
    await expect(page.getByTestId("stale-sections-note")).not.toContainText("hero");

    // The stale row shows a disabled/refused state, never a re-apply button.
    const staleRow = page.getByTestId("resume-op-row").filter({ has: page.getByTestId("resume-op-stale") });
    await expect(staleRow).toHaveCount(1);
    await expect(staleRow.getByTestId("resume-op-reapply")).toHaveCount(0);

    // The non-stale row: click the REAL "Re-apply" button (not the test hook) and see the
    // panel itself confirm it.
    const liveRow = page.getByTestId("resume-op-row").filter({ hasNotText: "stale" });
    await expect(liveRow).toHaveCount(1);
    await liveRow.getByTestId("resume-op-reapply").click();
    await expect(liveRow.getByTestId("resume-op-reapplied")).toBeVisible({ timeout: 10_000 });
    await expect(liveRow.getByTestId("resume-op-reapply")).toHaveCount(0); // button replaced by the confirmation

    // ── secondary sanity: the underlying store state matches what the UI just showed ──────

    const afterReapply = await page.evaluate(() => {
      const variants = (
        window as unknown as { __overlayVariantsStore: { getState: () => { hydratedOpIds: Set<string> } } }
      ).__overlayVariantsStore.getState();
      const memory = (
        window as unknown as { __overlayMemoryStore: { getState: () => { staleNodePaths: Set<string> } } }
      ).__overlayMemoryStore.getState();
      return { hydratedOpIds: [...variants.hydratedOpIds], stalePaths: [...memory.staleNodePaths] };
    });
    expect(afterReapply.hydratedOpIds, "the re-applied op left the hydrated set").not.toContain("op-live");
    expect(afterReapply.hydratedOpIds, "the stale op is still flagged (never guessed/applied)").toContain("op-stale");
    expect(afterReapply.stalePaths).toContain("vanished-section-from-last-session");
    expect(afterReapply.stalePaths).not.toContain("hero");
  });
});

// ── 6 (@ai, deferred) · live: reject with a reason -> the model's NEXT proposal respects it ──

test("6 · (@ai) reject a proposal with a reason -> the agent's next proposal in this area respects it (does NOT re-propose the rejected wording) @m4 @ai", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await submitAndWaitForExtraction(page);
  await page.waitForFunction(
    () => (window as unknown as { __overlayChatStore?: { getState: () => { streaming: boolean } } }).__overlayChatStore?.getState().streaming === false,
    { timeout: 90_000 }
  );

  // BLOCKER 3 fix (PR #41 review): capture the ORIGINAL page's real headline (schema store —
  // same technique as test 5) so we can assert the rejected PROPOSED wording specifically does
  // not recur, rather than the vacuous "some proposal exists" check the previous version had.
  const originalHeadline = await page.evaluate(() => {
    const schema = (
      window as unknown as { __overlaySchemaStore: { getState: () => { order: string[]; nodes: Record<string, { type: string; slots: Record<string, { text?: string }> }> } } }
    ).__overlaySchemaStore.getState();
    const heroId = schema.order.find((id) => schema.nodes[id].type === "hero");
    return heroId ? (schema.nodes[heroId].slots.headline?.text ?? null) : null;
  });

  await page.getByTestId("prompt-input-textarea").fill(
    'Propose changing the hero headline to something punchier via apply_op, right now.'
  );
  await page.getByTestId("prompt-input-submit").click();
  await expect(page.getByTestId("proposal-card")).toBeVisible({ timeout: 60_000 });

  // The exact wording the agent proposed and we're about to reject — THIS is the wording that
  // must never recur, not the original page copy.
  const rejectedHeadline = await page.evaluate(() => {
    const chat = (
      window as unknown as { __overlayChatStore: { getState: () => { blocks: { kind: string; op?: { slots: Record<string, { text?: string }> } }[] } } }
    ).__overlayChatStore.getState();
    const proposal = chat.blocks.find((b) => b.kind === "proposal");
    return proposal?.op?.slots.headline?.text ?? null;
  });
  expect(rejectedHeadline, "the proposal must actually target the headline slot").toBeTruthy();

  await page.getByRole("button", { name: /reject/i }).first().click();

  // Provide a reason in the follow-up (the app doesn't have a dedicated reason field yet —
  // the reason travels as the next chat message, same as any human clarification).
  await page.getByTestId("prompt-input-textarea").fill(
    `Rejected: "${rejectedHeadline}" — keep the current headline exactly as-is, our legal team already approved that exact wording and this specific replacement. Please respect this going forward and propose something meaningfully different instead.`
  );
  await page.getByTestId("prompt-input-submit").click();
  await page.waitForFunction(
    () => (window as unknown as { __overlayChatStore?: { getState: () => { streaming: boolean } } }).__overlayChatStore?.getState().streaming === false,
    { timeout: 90_000 }
  );

  await page.getByTestId("prompt-input-textarea").fill("Propose one more hero headline change via apply_op.");
  await page.getByTestId("prompt-input-submit").click();
  await page.waitForFunction(
    () => (window as unknown as { __overlayChatStore?: { getState: () => { streaming: boolean } } }).__overlayChatStore?.getState().streaming === false,
    { timeout: 90_000 }
  );

  const proposalsAfterRejection = await page.evaluate(() => {
    const chat = (
      window as unknown as { __overlayChatStore: { getState: () => { blocks: { kind: string; op?: { slots: Record<string, { text?: string }> } }[] } } }
    ).__overlayChatStore.getState();
    // Every proposal block AFTER the first (the rejected one) — index 1.. — is what the agent
    // proposed post-rejection.
    return chat.blocks
      .filter((b) => b.kind === "proposal")
      .slice(1)
      .map((b) => b.op?.slots.headline?.text)
      .filter((t): t is string => Boolean(t));
  });

  console.log(`[m4] rejected: ${JSON.stringify(rejectedHeadline)}; post-rejection proposals: ${JSON.stringify(proposalsAfterRejection)}`);

  // Non-vacuous: the agent must have actually proposed something new (not gone silent)...
  expect(proposalsAfterRejection.length, "the agent must propose a NEW change after the rejection, not go silent").toBeGreaterThan(0);
  // ...AND the specific rejected wording must never recur verbatim.
  for (const p of proposalsAfterRejection) {
    expect(p, `post-rejection proposal must not re-propose the rejected wording verbatim`).not.toBe(rejectedHeadline);
  }
});

// ── 7 (@ai, deferred) · live: the greeting on resume references what it knows ────────────

test("7 · (@ai) on a resumed session, the greeting references learnings/score/staleness @m4 @ai", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const seededState: MemoryState = {
    schema: { nodes: [], extractedAt: Date.now() },
    seo: null,
    brief: null,
    goal: "",
    experiments: [],
    variants: [
      {
        id: "v1",
        name: "Prior variant",
        goal: "",
        ops: [],
        score: { control: 0.4, variant: 0.52, delta: 0.12, confidence: 0.8, reasons: ["clearer CTA"] },
      },
    ],
    verdicts: [],
  };
  await page.goto("/");
  await page.request.post("/api/memory", {
    data: { site: "maxtechera.dev", memory: "- ICP responds to proof, not promises", state: seededState },
  });

  await submitAndWaitForExtraction(page);
  await page.waitForFunction(
    () => (window as unknown as { __overlayChatStore?: { getState: () => { streaming: boolean } } }).__overlayChatStore?.getState().streaming === false,
    { timeout: 90_000 }
  );

  const allTexts = await page.getByTestId("assistant-message").allInnerTexts();
  const reply = allTexts.join(" | ").toLowerCase();
  console.log(`[m4] resumed greeting verbatim: ${JSON.stringify(reply.slice(0, 500))}`);
  expect(reply).toMatch(/learning|remember|last session|resum|scored|\+0\.12/);
});
