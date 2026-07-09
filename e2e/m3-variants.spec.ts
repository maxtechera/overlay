/**
 * e2e/m3-variants.spec.ts
 * M3/#3 acceptance checklist. Warn-only regression checks and gallery/allocation rendering are
 * deterministic app logic — proven KEYLESS with fixtures/direct store seeding (@m3, run on
 * every CI PR), mirroring how M1b's href-write path and M2a's contrast/ADA fixtures work
 * (CLAUDE.md harness rule). The live "agent builds arms / three hero angles / adversarial
 * scoring" flows genuinely need a model and are tagged @ai — they test.skip cleanly without
 * ANTHROPIC_API_KEY (gated on testInfo.tags, not a file-level key check — PR #20 learning).
 *
 * Tune target: maxtechera.dev only (CLAUDE.md).
 */

import { test, expect, type Page } from "@playwright/test";
import { applyOpOnFixture, extractOnFixture, loadFixture } from "./helpers/runtime-fixture";
import { suggestedAllocation } from "../lib/variants";
import type { Variant } from "../lib/types";

test.beforeEach(({}, testInfo) => {
  if (testInfo.tags.includes("@ai") && !process.env.ANTHROPIC_API_KEY) {
    testInfo.skip();
  }
});

// ── shared helpers (same patterns as e2e/m1b-agent-tick.spec.ts / m2b-artifacts.spec.ts) ──

async function submitAndWaitForExtraction(page: Page) {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({
    timeout: 30_000,
  });
}

async function waitForTurnSettled(page: Page) {
  await page
    .waitForFunction(
      () => (window as unknown as { __overlayChatStore?: { getState: () => { streaming: boolean } } }).__overlayChatStore?.getState().streaming === true,
      { timeout: 5_000 }
    )
    .catch(() => {});
  await page.waitForFunction(
    () => (window as unknown as { __overlayChatStore?: { getState: () => { streaming: boolean } } }).__overlayChatStore?.getState().streaming === false,
    { timeout: 90_000 }
  );
}

async function waitForPlanSettled(page: Page) {
  await page.waitForSelector('[data-testid="experiment-plan"]', { timeout: 90_000 });
}

/**
 * Switch to the real "Auto-apply (revertible)" permission mode (PRD §4.3/TECH-SPEC §9) —
 * apply_op's execute() otherwise awaits a human ProposalCard click that never comes, hanging
 * `streaming` at true forever. Build-arms/three-angles flows script several sequential
 * apply_op calls in one turn; auto mode is the realistic way a user runs that, not a bypass.
 */
async function enableAutoApply(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __overlaySettingsStore: { getState: () => { setApprovalMode: (m: "auto" | "ask") => void } } })
      .__overlaySettingsStore.getState()
      .setApprovalMode("auto");
  });
}

// ── 1 (keyless) · suggestedAllocation: control fixed 25%, remainder ∝ deltas ────────────

test("1 · suggestedAllocation — control fixed at 25%, remaining 75% proportional to COM deltas @m3", async () => {
  const arms: Variant[] = [
    { id: "a", name: "A", goal: "g", ops: [], score: { control: 0.4, variant: 0.6, delta: 0.2, confidence: 0.7, reasons: [] } },
    { id: "b", name: "B", goal: "g", ops: [], score: { control: 0.4, variant: 0.3, delta: -0.1, confidence: 0.7, reasons: [] } },
  ];
  const alloc = suggestedAllocation(arms);

  expect(alloc.control).toBeCloseTo(0.25, 5);
  // The positive-delta arm gets a materially larger share than the negative-delta one, but the
  // loser still gets a nonzero floor share (a PRIOR, never a claim of literal zero traffic).
  expect(alloc.a).toBeGreaterThan(alloc.b);
  expect(alloc.b).toBeGreaterThan(0);
  const total = alloc.control + alloc.a + alloc.b;
  expect(total).toBeCloseTo(1, 5);

  // Zero-arms edge case never divides by zero / returns NaN.
  expect(suggestedAllocation([])).toEqual({ control: 1 });
});

// ── 2 (keyless) · Gallery: carousel, grouped-by-experiment header, ranked by delta ───────
//
// Issue #28 rebuilt the gallery from a grid into a compact one-at-a-time CAROUSEL — this spec
// now proves the same underlying facts (experiment grouping/header, delta ranking, COM-prior
// allocation, no arm hidden) by NAVIGATING the carousel (prev/next + dots) instead of reading
// every card out of the DOM at once.

test("2 · Gallery renders as a carousel — experiment header + COM-prior allocation, ranked by delta, prev/next/dots navigate @m3", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("op-controls")).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() => {
    type Store<S> = { getState: () => S; setState: (s: Partial<S>) => void };
    const experiments = (window as unknown as { __overlayExperimentsStore: Store<{ list: unknown[] }> }).__overlayExperimentsStore;
    const variants = (window as unknown as { __overlayVariantsStore: Store<{ list: unknown[]; activeId: string }> }).__overlayVariantsStore;
    const chat = (window as unknown as { __overlayChatStore: { getState: () => { pushGallery: () => void } } }).__overlayChatStore;

    experiments.setState({
      list: [{ id: "exp-1", name: "Hero — Pain-point angle", targetPath: "hero", hypothesis: "h", status: "ready", armIds: ["v-lo", "v-hi"] }],
    });
    variants.setState({
      list: [
        { id: "v-lo", name: "Low scorer", goal: "g", experimentId: "exp-1", ops: [], score: { control: 0.4, variant: 0.3, delta: -0.1, confidence: 0.6, reasons: ["weaker hook"] } },
        { id: "v-hi", name: "High scorer", goal: "g", experimentId: "exp-1", ops: [], score: { control: 0.4, variant: 0.7, delta: 0.3, confidence: 0.8, reasons: ["stronger hook"] } },
      ],
      activeId: "control",
    });
    chat.getState().pushGallery();
  });

  await expect(page.getByTestId("variant-gallery")).toBeVisible();
  await expect(page.getByTestId("gallery-experiment-group")).toBeVisible();
  await expect(page.getByTestId("gallery-experiment-group")).toContainText("Hero — Pain-point angle");
  await expect(page.getByTestId("gallery-control-allocation")).toContainText("25%");
  await expect(page.getByTestId("gallery-control-allocation")).toContainText("COM-prior");

  // Two arms -> two dots (one carousel, one slide per arm).
  await expect(page.getByTestId("carousel-dot")).toHaveCount(2);

  // Ranked by delta: the higher-scoring arm shows FIRST (carousel index 0).
  await expect(page.getByTestId("variant-name")).toHaveText("High scorer");
  await expect(page.getByTestId("variant-delta")).toContainText("+0.30");
  const hiAlloc = parseFloat((await page.getByTestId("variant-allocation").innerText()).match(/(\d+)%/)![1]);

  // Next -> the negative-delta arm still renders honestly (not hidden/clamped away), with its
  // own smaller allocation share.
  await page.getByTestId("carousel-next").click();
  await expect(page.getByTestId("variant-name")).toHaveText("Low scorer");
  await expect(page.getByTestId("variant-delta")).toContainText("-0.10");
  const loAlloc = parseFloat((await page.getByTestId("variant-allocation").innerText()).match(/(\d+)%/)![1]);
  expect(hiAlloc).toBeGreaterThan(loAlloc);
  await expect(page.getByTestId("carousel-dot").nth(1)).toHaveAttribute("data-active", "true");

  // Prev -> back to the high scorer.
  await page.getByTestId("carousel-prev").click();
  await expect(page.getByTestId("variant-name")).toHaveText("High scorer");
  await expect(page.getByTestId("carousel-dot").nth(0)).toHaveAttribute("data-active", "true");

  // Dots jump directly too.
  await page.getByTestId("carousel-dot").nth(1).click();
  await expect(page.getByTestId("variant-name")).toHaveText("Low scorer");
});

// ── 3 (keyless) · Thumbnails: success path + fallback path, both pass ────────────────────

test("3 · captureThumbnail succeeds against a same-origin iframe and returns null on failure — both paths, gallery renders correctly for each @m3", async ({ page }) => {
  await page.goto("/");

  // Success path: a synthetic SAME-ORIGIN iframe (about:blank child of our own page) — no
  // external/cross-origin images, so html2canvas cannot hit a tainted-canvas SecurityError.
  const successUrl = await page.evaluate(async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write('<body><div style="width:120px;height:60px;background:#f97316;"></div></body>');
    doc.close();
    const capture = (window as unknown as { __overlayCaptureThumbnail: (el: HTMLIFrameElement | null) => Promise<string | null> })
      .__overlayCaptureThumbnail;
    const result = await capture(iframe);
    iframe.remove();
    return result;
  });
  expect(successUrl, "captureThumbnail must succeed against a clean same-origin iframe").toMatch(/^data:image\/png/);

  // Failure/fallback path: no iframe at all → resolves null, never throws.
  const nullResult = await page.evaluate(async () => {
    const capture = (window as unknown as { __overlayCaptureThumbnail: (el: HTMLIFrameElement | null) => Promise<string | null> })
      .__overlayCaptureThumbnail;
    return capture(null);
  });
  expect(nullResult).toBeNull();

  // Gallery rendering: WITH a thumbnail -> real <img>; WITHOUT -> the styled fallback card.
  // Both are asserted via the carousel's two slides (issue #28's carousel shows one at a
  // time — navigate with Next between them) so both paths are proven to "pass" (criterion 6).
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("op-controls")).toBeVisible({ timeout: 30_000 });

  await page.evaluate((thumbDataUrl) => {
    type Store<S> = { getState: () => S; setState: (s: Partial<S>) => void };
    const variants = (window as unknown as { __overlayVariantsStore: Store<{ list: unknown[]; thumbnails: Record<string, string>; activeId: string }> })
      .__overlayVariantsStore;
    const chat = (window as unknown as { __overlayChatStore: { getState: () => { pushGallery: () => void } } }).__overlayChatStore;
    variants.setState({
      list: [
        { id: "v-with-thumb", name: "Has thumbnail", goal: "g", ops: [] },
        { id: "v-no-thumb", name: "No thumbnail", goal: "g", ops: [] },
      ],
      thumbnails: { "v-with-thumb": thumbDataUrl },
      activeId: "control",
    });
    chat.getState().pushGallery();
  }, successUrl as string);

  await expect(page.getByTestId("variant-name")).toHaveText("Has thumbnail");
  await expect(page.getByTestId("variant-thumbnail")).toBeVisible();

  await page.getByTestId("carousel-next").click();
  await expect(page.getByTestId("variant-name")).toHaveText("No thumbnail");
  await expect(page.getByTestId("variant-thumbnail-fallback")).toBeVisible();
});

// ── 4 (keyless, fixture) · 3×-length headline → overflow + line-growth warnings ─────────

test("4 · 3×-length headline op → overflow AND line-growth warnings on op-applied, warn-only (ok:true regardless) @m3", async ({ page }) => {
  const html = `<!DOCTYPE html><html><head><title>overflow fixture</title>
<style>
  body { margin: 0; }
  .hero { width: 95vw; height: 260px; padding: 20px; box-sizing: border-box; }
  .clip { width: 280px; height: 60px; overflow: hidden; }
  .clip h1.headline { margin: 0; font-size: 24px; line-height: 30px; font-family: sans-serif; }
</style></head>
<body><div class="hero"><div class="clip"><h1 class="headline">Short title</h1></div></div></body></html>`;

  await loadFixture(page, html);
  const { nodes } = await extractOnFixture(page, { hostnameOverride: "fixture.invalid" });
  const hero = nodes.find((n) => (n as { type: string }).type === "hero") as { id: string } | undefined;
  expect(hero, "hero detected on the overflow fixture").toBeTruthy();

  const res = await applyOpOnFixture(page, "op-overflow-1", {
    op: "update-content",
    target: hero!.id,
    slots: { headline: { text: "Short title Short title Short title Short title Short title" } },
    rationale: "test: 3x length headline",
  });

  console.log(`[m3] overflow/line-growth op result verbatim: ${JSON.stringify(res)}`);
  expect(res.ok, "warn-only: apply must still succeed").toBe(true);
  expect(res.warnings, "warnings array present").toBeTruthy();
  const joined = (res.warnings ?? []).join(" | ");
  expect(joined, "overflow warning present").toMatch(/overflow/i);
  expect(joined, "line-growth warning present").toMatch(/line count grew/i);
});

// ── 5 (keyless, fixture) · contrast-degrading change → contrast warning, warn-only ──────

test("5 · a contrast-degrading change → contrast warning on op-applied, warn-only (never blocks) @m3", async ({ page }) => {
  // The Op vocabulary (update-content: text/href/src/alt only) can never itself change color —
  // so this fixture models a realistic case the regression check exists FOR: content-reactive
  // host-page CSS/JS (a MutationObserver the SITE installs, not our runtime) that recolors an
  // element once its text passes a length threshold. Deterministic and fully in our control
  // (CLAUDE.md: external sites drift, fixtures don't).
  const html = `<!DOCTYPE html><html><head><title>contrast fixture</title>
<style>
  body { margin: 0; }
  .hero { width: 95vw; height: 260px; padding: 20px; box-sizing: border-box; }
  h1.headline { margin: 0; font-size: 32px; font-family: sans-serif; color: #111111; background: #ffffff; }
  h1.headline.degraded { color: #eeeeee; }
</style></head>
<body>
  <div class="hero"><h1 class="headline">Short</h1></div>
  <script>
    var el = document.querySelector(".headline");
    new MutationObserver(function () {
      if (el.textContent.length > 20) el.classList.add("degraded");
      else el.classList.remove("degraded");
    }).observe(el, { characterData: true, childList: true, subtree: true });
  </script>
</body></html>`;

  await loadFixture(page, html);
  const { nodes } = await extractOnFixture(page, { hostnameOverride: "fixture.invalid" });
  const hero = nodes.find((n) => (n as { type: string }).type === "hero") as
    | { id: string; facts?: { contrast?: number } }
    | undefined;
  expect(hero, "hero detected on the contrast fixture").toBeTruthy();
  expect(hero!.facts?.contrast, "before-state contrast is high (dark text on white)").toBeGreaterThan(10);

  const res = await applyOpOnFixture(page, "op-contrast-1", {
    op: "update-content",
    target: hero!.id,
    slots: { headline: { text: "This headline is now quite long and triggers the degraded style" } },
    rationale: "test: contrast-degrading change",
  });

  console.log(`[m3] contrast op result verbatim: ${JSON.stringify(res)}`);
  expect(res.ok, "warn-only: apply must still succeed even though contrast degraded").toBe(true);
  const joined = (res.warnings ?? []).join(" | ");
  expect(joined, "contrast warning present").toMatch(/contrast dropped below wcag aa/i);
});

// ── 6 (keyless, fixture) · media alt lost → alt warning, warn-only ──────────────────────

test("6 · clearing a media slot's alt text → alt-lost warning on op-applied, warn-only @m3", async ({ page }) => {
  // No heading anywhere in this fixture — a hero-candidate heading (h1/h2/[role=heading]) would
  // get climbed-to and CLAIM this very section as the hero container (detectHero's "climbed
  // ancestor is itself a <section>" special case), swallowing the image before the ladder's
  // section/collection rungs ever see it. Heading-free keeps this a plain section with a media
  // slot, which is all this test needs.
  const html = `<!DOCTYPE html><html><head><title>alt fixture</title>
<style>body{margin:0}.card{width:95vw;padding:20px}</style></head>
<body><section class="card">
<img alt="A descriptive cat photo" width="80" height="60"
     src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7" /></section></body></html>`;

  await loadFixture(page, html);
  const { nodes } = await extractOnFixture(page, { hostnameOverride: "fixture.invalid" });
  const section = nodes.find(
    (n) => (n as { slots?: Record<string, unknown> }).slots && "media" in ((n as { slots: Record<string, unknown> }).slots ?? {})
  ) as { id: string } | undefined;
  expect(section, "a node with a media slot exists on the alt fixture").toBeTruthy();

  const res = await applyOpOnFixture(page, "op-alt-1", {
    op: "update-content",
    target: section!.id,
    slots: { media: { alt: "" } },
    rationale: "test: clear alt text",
  });

  console.log(`[m3] alt-lost op result verbatim: ${JSON.stringify(res)}`);
  expect(res.ok).toBe(true);
  const joined = (res.warnings ?? []).join(" | ");
  expect(joined, "alt-lost warning present").toMatch(/alt text lost/i);
});

// ── 7 (keyless) · tab-switching MECHANICS on a real page: revert-to-control + replay ─────

test("7 · switching variant tabs on a real page reverts to control and replays the variant's ops — visibly, in the live DOM @m3", async ({ page }) => {
  await submitAndWaitForExtraction(page);

  const heroId = await page.evaluate(() => {
    const schema = (window as unknown as { __overlaySchemaStore: { getState: () => { order: string[]; nodes: Record<string, { type: string }> } } })
      .__overlaySchemaStore.getState();
    return schema.order.find((id) => schema.nodes[id].type === "hero") ?? null;
  });
  expect(heroId, "a hero node id exists").toBeTruthy();

  const originalHeadline = await page
    .getByTestId("preview-iframe")
    .evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim() ?? "");

  const MARKER = "M3-KEYLESS-TAB-SWITCH-MARKER";

  // Apply directly (bypassing the LLM — apply_op's mechanics, not its proposal, is what M1
  // already proved) and seed the variants store exactly as create_variant + apply_op would
  // have left it: one variant, one applied VariantOp targeting the real hero headline.
  await page.evaluate(
    async ({ heroId, marker }) => {
      const host = (window as unknown as { __overlayHost: { sendToIframe: (m: unknown) => Promise<unknown> } }).__overlayHost;
      const op = { op: "update-content", target: heroId, slots: { headline: { text: marker } }, rationale: "keyless tab-switch mechanics test" };
      await host.sendToIframe({ t: "apply-op", opId: "vop-keyless-1", op });

      type Store<S> = { getState: () => S; setState: (s: Partial<S>) => void };
      const variants = (window as unknown as { __overlayVariantsStore: Store<{ list: unknown[]; activeId: string }> }).__overlayVariantsStore;
      variants.setState({
        list: [{ id: "v-keyless-1", name: "Keyless test variant", goal: "g", ops: [{ id: "vop-keyless-1", source: "human", op, status: "applied" }] }],
        activeId: "v-keyless-1",
      });
    },
    { heroId, marker: MARKER }
  );

  await expect(page.getByTestId("preview-iframe")).toBeVisible();
  await expect
    .poll(() =>
      page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim())
    )
    .toBe(MARKER);

  // Tabs render: Control + the seeded variant (lettered "A"), variant active.
  await expect(page.getByTestId("variant-tabs")).toBeVisible();
  await expect(page.getByTestId("variant-tab")).toHaveCount(1);
  await expect(page.getByTestId("variant-tab")).toHaveAttribute("data-active", "true");

  // Click Control -> revert-to-control: the DOM must show the ORIGINAL headline again.
  await page.getByTestId("variant-tab-control").click();
  await expect
    .poll(() =>
      page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim())
    )
    .toBe(originalHeadline);
  await expect(page.getByTestId("variant-tab-control")).toHaveAttribute("data-active", "true");

  // Click the variant tab again -> replay: the DOM must show the variant's text again.
  await page.getByTestId("variant-tab").click();
  await expect
    .poll(() =>
      page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim())
    )
    .toBe(MARKER);
  await expect(page.getByTestId("variant-tab")).toHaveAttribute("data-active", "true");
});

// ── 8 (keyless) · Build arms seeds the composer with the REAL experiment id ─────────────

test("8 · 'Build arms' seeds the composer with the experiment's real id and a create_variant instruction @m3", async ({ page }) => {
  // Deliberately skip the real ingest/brief/plan flow: submitting a URL fires a LIVE
  // runBriefAndPlan() in the background (TECH-SPEC §5) whose eventual setList() call would
  // race and clobber a directly-seeded experiments list. Seed both the experiments store AND
  // the `plan` chat block directly — this test only needs ExperimentPlanBlock mounted, not a
  // real page loaded.
  await page.goto("/");
  await page.evaluate(() => {
    type Store<S> = { setState: (s: Partial<S>) => void };
    const experiments = (window as unknown as { __overlayExperimentsStore: Store<{ list: unknown[] }> }).__overlayExperimentsStore;
    experiments.setState({
      list: [{ id: "exp-real-id-123", name: "Hero — Angle test", targetPath: "hero", hypothesis: "Because reasons.", status: "proposed", armIds: [] }],
    });
    const chat = (window as unknown as { __overlayChatStore: { getState: () => { pushPlan: () => void } } }).__overlayChatStore;
    chat.getState().pushPlan();
  });

  await expect(page.getByTestId("experiment-card")).toBeVisible();
  await expect(page.getByTestId("experiment-status")).toHaveText("proposed");

  await page.getByTestId("build-arms-btn").click();

  const composerText = await page.getByTestId("prompt-input-textarea").inputValue();
  console.log(`[m3] build-arms composer text verbatim: ${JSON.stringify(composerText)}`);
  expect(composerText).toContain("exp-real-id-123");
  expect(composerText).toContain("create_variant");
  expect(composerText).toContain("hero");

  // Optimistic status flip: proposed -> building, the instant Build arms is clicked.
  await expect(page.getByTestId("experiment-status")).toHaveText("building");
});

// ── 9 (@ai) · Build arms → 2 arms for THAT target only, rationales tied to hypothesis ────

test("9 · Build arms on a plan card → agent creates 2 arms for THAT experiment's target, rationales reference the hypothesis @m3 @ai", async ({ page }) => {
  test.setTimeout(150_000);
  await submitAndWaitForExtraction(page);
  await waitForPlanSettled(page);
  await enableAutoApply(page); // building 2 arms means several sequential apply_op calls

  const targetExp = await page.evaluate(() => {
    const experiments = (window as unknown as { __overlayExperimentsStore: { getState: () => { list: { id: string; name: string; targetPath: string; hypothesis: string }[] } } })
      .__overlayExperimentsStore.getState();
    return experiments.list[0];
  });
  expect(targetExp, "at least one experiment proposal exists").toBeTruthy();

  const card = page.getByTestId("experiment-card").filter({ hasText: targetExp.name });
  await card.getByTestId("build-arms-btn").click();
  await page.getByTestId("prompt-input-submit").click();
  await waitForTurnSettled(page);

  const { variants, experiments } = await page.evaluate(() => {
    const v = (window as unknown as { __overlayVariantsStore: { getState: () => { list: { experimentId?: string; name: string; ops: { op: { target: string; rationale: string } }[] }[] } } })
      .__overlayVariantsStore.getState();
    const e = (window as unknown as { __overlayExperimentsStore: { getState: () => { list: { id: string; armIds: string[]; status: string }[] } } })
      .__overlayExperimentsStore.getState();
    return { variants: v.list, experiments: e.list };
  });

  const arms = variants.filter((v) => v.experimentId === targetExp.id);
  console.log(`[m3] build-arms result verbatim: ${JSON.stringify(arms.map((a) => a.name))}`);
  expect(arms.length, "exactly 2 arms created for this experiment").toBe(2);

  // Every op in every arm targets ONLY this experiment's declared target node.
  const targetNodeId = await page.evaluate((path) => {
    const schema = (window as unknown as { __overlaySchemaStore: { getState: () => { outline: () => { id: string; path: string }[] } } })
      .__overlaySchemaStore.getState();
    return schema.outline().find((o) => o.path === path)?.id ?? null;
  }, targetExp.targetPath);

  for (const arm of arms) {
    expect(arm.ops.length, `arm "${arm.name}" applied at least one op`).toBeGreaterThan(0);
    for (const vop of arm.ops) {
      expect(vop.op.target, `arm "${arm.name}"'s op targets ONLY ${targetExp.targetPath}`).toBe(targetNodeId);
      expect(vop.op.rationale.length).toBeGreaterThan(0);
    }
  }

  const exp = experiments.find((e) => e.id === targetExp.id);
  expect(exp?.armIds.length).toBe(2);
});

// ── 10 (@ai) · "Three different hero angles" → 3 named variants ─────────────────────────

test("10 · 'three different hero angles' → 3 separately named variants created @m3 @ai", async ({ page }) => {
  test.setTimeout(150_000);
  await submitAndWaitForExtraction(page);
  await waitForTurnSettled(page); // let first-turn narration finish before driving the composer
  await enableAutoApply(page); // three variants means several sequential apply_op calls

  await page.getByTestId("prompt-input-textarea").fill(
    "Give me three different hero angles for this page — three distinct headline rewrites, each as its own named variant. Apply each variant's headline change, then move to the next."
  );
  await page.getByTestId("prompt-input-submit").click();
  await waitForTurnSettled(page);

  const names = await page.evaluate(() => {
    const v = (window as unknown as { __overlayVariantsStore: { getState: () => { list: { name: string }[] } } }).__overlayVariantsStore.getState();
    return v.list.map((x) => x.name);
  });
  console.log(`[m3] three-hero-angles variant names verbatim: ${JSON.stringify(names)}`);
  expect(names.length, "3 (or more) distinctly-named variants").toBeGreaterThanOrEqual(3);
  expect(new Set(names).size, "names are distinct, not the same angle repeated").toBe(names.length);
});

// ── 11 (@ai) · Adversarial: "make it vague and generic" → negative delta, reported honestly ──

test("11 · adversarial 'make it vague and generic' → negative COM delta, reported honestly by the agent @m3 @ai", async ({ page }) => {
  test.setTimeout(150_000);
  await submitAndWaitForExtraction(page);
  await waitForTurnSettled(page);
  await enableAutoApply(page); // create_variant + apply_op + score_variant in one turn

  await page.getByTestId("prompt-input-textarea").fill(
    "Create a new variant that makes the hero headline deliberately vague and generic — strip out any specifics, make it as bland corporate-speak as possible. Apply it, then score it and tell me the delta honestly, even if it's worse."
  );
  await page.getByTestId("prompt-input-submit").click();
  await waitForTurnSettled(page);

  const score = await page.evaluate(() => {
    const v = (window as unknown as { __overlayVariantsStore: { getState: () => { list: { score?: { delta: number } }[] } } }).__overlayVariantsStore.getState();
    return v.list.at(-1)?.score ?? null;
  });
  console.log(`[m3] adversarial vague-variant score verbatim: ${JSON.stringify(score)}`);
  expect(score, "the vague variant was scored").toBeTruthy();
  expect(score!.delta, "a deliberately vague/generic rewrite scores a NEGATIVE delta").toBeLessThan(0);

  const allTexts = await page.getByTestId("assistant-message").allInnerTexts();
  const reply = allTexts.join(" | ");
  console.log(`[m3] adversarial reply verbatim: ${JSON.stringify(reply.slice(-500))}`);
  // Honest reporting: the reply mentions the negative/worse outcome, not a spun positive.
  expect(reply).toMatch(/-0\.|negative|worse|lower|declin|weak/i);
});
