/**
 * e2e/m-ux-variants-5.spec.ts
 * Issue #35 acceptance checklist — raises the variant-carousel cap from 4 to 5 per
 * module/experiment and re-verifies the carousel is a genuine PICK-ONE: all 5 arms rendered
 * one at a time, ranked by COM delta INCLUDING the weakest (never hidden), and switching the
 * live preview always requires an explicit click — never auto-applied.
 *
 * All KEYLESS (CLAUDE.md harness rule + issue #35 note: Anthropic account is out of credits).
 * The clamp and the carousel are deterministic app logic — proven the same way
 * e2e/m-ux-chat-variants.spec.ts and e2e/m3-variants.spec.ts prove the rest of this feature
 * (direct store seeding + real DOM assertions; only the live-preview-apply test touches a real
 * page, to exercise the real apply/revert round-trip against a real hero node).
 * The agent-COPY-STEERING half of item 4 (lib/prompts.ts tightened to "5 focused, small,
 * one-module" guidance) is prompt text only — code-reviewed, not exercised by a spec, per the
 * out-of-credits note.
 *
 * Tune target: maxtechera.dev only (CLAUDE.md) — only the live-preview test touches a page.
 */

import { test, expect, type Page } from "@playwright/test";

type VariantsStore = {
  getState: () => { list: unknown[]; activeId: string };
  setState: (s: Partial<{ list: unknown[]; activeId: string }>) => void;
};
type ChatStore = { getState: () => { pushGallery: () => void } };

function seedFiveArms(page: Page, heroId?: string) {
  return page.evaluate(
    ({ heroId }) => {
      // 5 ad-hoc arms (no experimentId — same ranking path as an experiment's arms), deltas
      // spanning best to worst, deliberately NOT pre-sorted, to prove the gallery ranks them
      // itself rather than trusting insertion order. Only two carry a real applied op against
      // the live hero (headline text markers) — enough to prove the explicit-apply round-trip
      // without needing every arm to be a real op.
      const ops = heroId
        ? {
            v3: { op: "update-content", target: heroId, slots: { headline: { text: "FIVE-CAROUSEL-MID" } }, rationale: "mid arm" },
            v1: { op: "update-content", target: heroId, slots: { headline: { text: "FIVE-CAROUSEL-BEST" } }, rationale: "best arm" },
          }
        : undefined;

      const list = [
        {
          id: "v2",
          name: "Angle 2 (2nd best)",
          goal: "g",
          ops: [],
          score: { control: 0.4, variant: 0.55, delta: 0.15, confidence: 0.7, reasons: ["solid hook"] },
        },
        {
          id: "v5",
          name: "Angle 5 (weakest)",
          goal: "g",
          ops: [],
          score: { control: 0.4, variant: 0.2, delta: -0.2, confidence: 0.6, reasons: ["flat, generic"] },
        },
        {
          id: "v1",
          name: "Angle 1 (best)",
          goal: "g",
          ops: ops ? [{ id: "vop-1", source: "human", op: ops.v1, status: "applied" }] : [],
          score: { control: 0.4, variant: 0.7, delta: 0.3, confidence: 0.8, reasons: ["strongest hook"] },
        },
        {
          id: "v4",
          name: "Angle 4 (2nd weakest)",
          goal: "g",
          ops: [],
          score: { control: 0.4, variant: 0.3, delta: -0.1, confidence: 0.6, reasons: ["weak CTA"] },
        },
        {
          id: "v3",
          name: "Angle 3 (middle)",
          goal: "g",
          ops: ops ? [{ id: "vop-3", source: "human", op: ops.v3, status: "applied" }] : [],
          score: { control: 0.4, variant: 0.45, delta: 0.05, confidence: 0.6, reasons: ["mild lift"] },
        },
      ];

      (window as unknown as { __overlayVariantsStore: VariantsStore }).__overlayVariantsStore.setState({ list, activeId: "control" });
      (window as unknown as { __overlayChatStore: ChatStore }).__overlayChatStore.getState().pushGallery();
    },
    { heroId }
  );
}

// ── 1 · create_variant clamped at 5/module (6th call ignored) ──────────────────────────────

test("1 · create_variant is clamped at 5 per module/experiment — a 6th call is ignored, not created @ux", async ({ page }) => {
  await page.goto("/");

  const outputs = await page.evaluate(async () => {
    type Tools = { create_variant: { execute: (input: { name: string; experimentId?: string }, opts: { toolCallId: string }) => Promise<unknown> } };
    type MakeTools = (deps: { send: (m: unknown) => Promise<unknown> }) => Tools;
    const tools = (window as unknown as { __overlayMakeTools: MakeTools }).__overlayMakeTools({ send: () => Promise.reject(new Error("not used")) });
    const results: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(await tools.create_variant.execute({ name: `Module Angle ${i + 1}`, experimentId: "exp-issue-35" }, { toolCallId: `i35-${i}` }));
    }
    return results;
  });

  expect(outputs).toHaveLength(6);
  expect(outputs.slice(0, 5).every((o) => (o as { created?: boolean }).created === true), "all 5 of the first calls create an arm").toBe(true);
  const sixth = outputs[5] as { created?: boolean; reason?: string };
  expect(sixth.created, "the 6th call for the same module/experiment is ignored").toBe(false);
  expect(sixth.reason ?? "").toMatch(/max 5/i);
});

// ── 2 · Carousel: 5 slides, ranked by delta INCLUDING the weakest ─────────────────────────

test("2 · carousel renders all 5 variants for the module, ranked best→worst by COM delta, weakest never hidden @ux", async ({ page }) => {
  await page.goto("/");
  await seedFiveArms(page);

  await expect(page.getByTestId("variant-gallery")).toBeVisible();
  await expect(page.getByTestId("carousel-dot")).toHaveCount(5);

  const expectedOrder = [
    { name: "Angle 1 (best)", delta: "+0.30" },
    { name: "Angle 2 (2nd best)", delta: "+0.15" },
    { name: "Angle 3 (middle)", delta: "+0.05" },
    { name: "Angle 4 (2nd weakest)", delta: "-0.10" },
    { name: "Angle 5 (weakest)", delta: "-0.20" },
  ];

  for (let i = 0; i < expectedOrder.length; i++) {
    await expect(page.getByTestId("carousel-dot").nth(i)).toHaveAttribute("data-active", i === 0 ? "true" : "false");
    if (i > 0) await page.getByTestId("carousel-next").click();
    await expect(page.getByTestId("variant-name")).toHaveText(expectedOrder[i].name);
    await expect(page.getByTestId("variant-delta")).toContainText(expectedOrder[i].delta);
  }

  // The weakest arm (Angle 5, -0.20) is the LAST slide — present and legible, not clamped away
  // or hidden: the honesty is the point (issue #35).
  await expect(page.getByTestId("variant-name")).toHaveText("Angle 5 (weakest)");
  const weakestBadge = page.getByTestId("variant-delta");
  await expect(weakestBadge).toBeVisible();
  await expect(weakestBadge).toContainText("-0.20");
});

// ── 3 · Nothing is auto-applied — every slide requires an explicit click to activate ───────

test("3 · seeding/viewing the 5-variant carousel never auto-applies one — activeId stays 'control' until a click @ux", async ({ page }) => {
  await page.goto("/");
  await seedFiveArms(page);

  await expect(page.getByTestId("variant-gallery")).toBeVisible();

  // Merely being visible (and navigated through) does not switch anything.
  for (let i = 0; i < 4; i++) await page.getByTestId("carousel-next").click();
  const activeIdAfterBrowsing = await page.evaluate(() => (window as unknown as { __overlayVariantsStore: VariantsStore }).__overlayVariantsStore.getState().activeId);
  expect(activeIdAfterBrowsing, "browsing the carousel alone never applies a variant").toBe("control");

  // Every unapplied slide's button reads "Apply" (not already marked active).
  await page.getByTestId("carousel-dot").nth(0).click();
  await expect(page.getByTestId("variant-apply-btn")).toHaveText("Apply");
  await expect(page.getByTestId("variant-card")).toHaveAttribute("data-active", "false");
});

// ── 4 · Explicit click applies exactly that variant, visibly marks it, updates the preview ─

test("4 · clicking Apply on one of the 5 slides activates that variant, marks it visibly, and updates the live preview @ux", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({ timeout: 30_000 });

  const heroId = await page.evaluate(() => {
    const schema = (window as unknown as { __overlaySchemaStore: { getState: () => { order: string[]; nodes: Record<string, { type: string }> } } }).__overlaySchemaStore.getState();
    return schema.order.find((id) => schema.nodes[id].type === "hero") ?? null;
  });
  expect(heroId, "a hero node id exists").toBeTruthy();

  await seedFiveArms(page, heroId as string);
  await expect(page.getByTestId("variant-gallery")).toBeVisible();

  // Slide 0 is "Angle 1 (best)" (ranked first) — apply it.
  await expect(page.getByTestId("variant-name")).toHaveText("Angle 1 (best)");
  await page.getByTestId("variant-apply-btn").click();

  await expect
    .poll(() => page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim()))
    .toBe("FIVE-CAROUSEL-BEST");
  await expect(page.getByTestId("variant-card")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("variant-apply-btn")).toHaveText("Active on preview");
  expect(await page.evaluate(() => (window as unknown as { __overlayVariantsStore: VariantsStore }).__overlayVariantsStore.getState().activeId)).toBe("v1");

  // Navigate to slide index 2 ("Angle 3 (middle)", the other arm with a real op) and apply it —
  // explicit re-selection reverts v1 and replays v3 on the SAME live preview; the previous
  // slide's marker disappears (it is no longer active) once we come back around to it.
  await page.getByTestId("carousel-next").click();
  await page.getByTestId("carousel-next").click();
  await expect(page.getByTestId("variant-name")).toHaveText("Angle 3 (middle)");
  await expect(page.getByTestId("variant-apply-btn")).toHaveText("Apply");

  await page.getByTestId("variant-apply-btn").click();
  await expect
    .poll(() => page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim()))
    .toBe("FIVE-CAROUSEL-MID");
  await expect(page.getByTestId("variant-card")).toHaveAttribute("data-active", "true");
  expect(await page.evaluate(() => (window as unknown as { __overlayVariantsStore: VariantsStore }).__overlayVariantsStore.getState().activeId)).toBe("v3");

  // Going back to slide 0 shows it is no longer the applied one.
  await page.getByTestId("carousel-dot").nth(0).click();
  await expect(page.getByTestId("variant-name")).toHaveText("Angle 1 (best)");
  await expect(page.getByTestId("variant-card")).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("variant-apply-btn")).toHaveText("Apply");
});
