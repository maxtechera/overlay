/**
 * e2e/ux-overlay-scores.spec.ts
 * Issue #36 acceptance checklist — "Overlay: per-section optimization score from the brief,
 * shown on each box".
 *
 * The scoring pass (lib/section-scores.ts) calls a real Haiku model — NOT exercised live here
 * (CLAUDE.md/issue #36 note: the Anthropic account is out of credits). Every spec below is
 * keyless: it seeds the schema + scores stores directly via the same test-hook pattern
 * e2e/m3-variants.spec.ts uses for the gallery (`__overlayScoresStore.getState().setScores(...)`)
 * and proves the REAL plumbing — protocol message → lib/runtime.ts's overlay draw — end to end,
 * without needing the LLM call itself to succeed. lib/section-scores.ts's grounding logic (drop
 * any path that isn't a real extracted node) is code-reviewed in the PR; the render-side half of
 * "no invented targets" (a score for a path with no matching node can never draw a badge — the
 * draw loop iterates real nodes, not score-store keys) IS exercised here (test 2).
 *
 * Tune target: maxtechera.dev only (CLAUDE.md).
 */

import { test, expect, type Page } from "@playwright/test";

async function submitAndWaitForExtraction(page: Page) {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({
    timeout: 30_000,
  });
}

/** Real extracted node paths — read straight off the schema store (never hardcoded), so a
 *  test that seeds scores for these paths is provably scoring REAL sections, per issue #36's
 *  "no invented targets" item. */
async function realNodePaths(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Store = { getState: () => { order: string[]; nodes: Record<string, { path: string }> } };
    const schema = (window as unknown as { __overlaySchemaStore?: Store }).__overlaySchemaStore;
    if (!schema) return [];
    const { order, nodes } = schema.getState();
    return order.map((id) => nodes[id].path);
  });
}

/** Score badges are the `div[data-overlay-score]` elements lib/runtime.ts's drawScoreBadge
 *  appends into the overlay container (same container m-ux-preview.spec.ts's overlayBoxLabels
 *  reads, id'd by its zIndex 2147483646 inline style). Returns { path, score } for each. */
async function overlayScoreBadges(page: Page): Promise<{ path: string; score: string }[]> {
  return page.evaluate(() => {
    const iframe = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement | null;
    const doc = iframe?.contentDocument;
    if (!doc) return [];
    const container = doc.querySelector("div[style*='2147483646']");
    if (!container) return [];
    return Array.from(container.querySelectorAll("[data-overlay-score]")).map((el) => ({
      path: el.getAttribute("data-overlay-score-path") ?? "",
      score: el.getAttribute("data-overlay-score") ?? "",
    }));
  });
}

async function seedScores(page: Page, scores: Record<string, { score: number; reason?: string }>) {
  await page.evaluate((s) => {
    type Store = { getState: () => { setScores: (scores: typeof s) => void } };
    const store = (window as unknown as { __overlayScoresStore?: Store }).__overlayScoresStore;
    store?.getState().setScores(s);
  }, scores);
}

// ── 1 · overlay boxes show a real per-section optimization score, badges render with values ──

test("1 · overlay boxes show a per-section optimization score after seeding — badges render with the real values @ux", async ({
  page,
}) => {
  await submitAndWaitForExtraction(page);
  await expect(page.getByTestId("op-controls")).toBeVisible({ timeout: 5_000 });

  const paths = await realNodePaths(page);
  expect(paths.length, "extraction found at least one real section/node to score").toBeGreaterThan(0);

  const heroPath = paths.find((p) => p === "hero") ?? paths[0];
  const scores: Record<string, { score: number; reason?: string }> = {
    [heroPath]: { score: 82, reason: "headline undersells the value prop vs. the brief's ICP" },
  };
  // Score every extracted node — "every extracted section/component" per issue #36 item 1.
  for (const p of paths) if (!(p in scores)) scores[p] = { score: 35 };

  await seedScores(page, scores);

  await expect.poll(() => overlayScoreBadges(page).then((b) => b.length), { timeout: 5_000 }).toBe(paths.length);

  const badges = await overlayScoreBadges(page);
  const heroBadge = badges.find((b) => b.path === heroPath);
  expect(heroBadge?.score, `expected the hero's badge to show 82, got: ${JSON.stringify(badges)}`).toBe("82");
});

// ── 2 · scores map to real extracted sections — no invented targets ────────────────────────

test("2 · a score for a path with no matching extracted node never renders a badge — grounded to real sections only @ux", async ({
  page,
}) => {
  await submitAndWaitForExtraction(page);
  await expect(page.getByTestId("op-controls")).toBeVisible({ timeout: 5_000 });

  const paths = await realNodePaths(page);
  expect(paths.length).toBeGreaterThan(0);

  const invented = "totally-invented-section-xyz";
  expect(paths, "the invented path must not already be a real one").not.toContain(invented);

  await seedScores(page, {
    [paths[0]]: { score: 60 },
    [invented]: { score: 99 }, // no node has this path — must never draw
  });

  await expect.poll(() => overlayScoreBadges(page).then((b) => b.length), { timeout: 5_000 }).toBeGreaterThan(0);

  const badges = await overlayScoreBadges(page);
  expect(
    badges.some((b) => b.path === invented),
    `no badge should render for the invented path; got: ${JSON.stringify(badges)}`
  ).toBe(false);
  // Exactly one real badge drawn (only paths[0] was scored) — the invented entry contributed
  // nothing, proving the draw loop is grounded to real nodes, not to whatever's in the store.
  expect(badges.length).toBe(1);
  expect(badges[0].path).toBe(paths[0]);
});

// ── 3 · badges survive an overlay toggle off/on (re-draw reads the same score set) ─────────

test("3 · score badges reappear after hiding and re-showing the overlay @ux", async ({ page }) => {
  await submitAndWaitForExtraction(page);
  await expect(page.getByTestId("op-controls")).toBeVisible({ timeout: 5_000 });

  const paths = await realNodePaths(page);
  await seedScores(page, Object.fromEntries(paths.map((p) => [p, { score: 50 }])));
  await expect.poll(() => overlayScoreBadges(page).then((b) => b.length), { timeout: 5_000 }).toBe(paths.length);

  await page.getByTestId("overlay-btn").click(); // hide
  await expect(page.getByTestId("overlay-btn")).toHaveText(/show overlay/i);
  await expect.poll(() => overlayScoreBadges(page).then((b) => b.length)).toBe(0);

  await page.getByTestId("overlay-btn").click(); // show again
  await expect(page.getByTestId("overlay-btn")).toHaveText(/hide overlay/i);
  await expect.poll(() => overlayScoreBadges(page).then((b) => b.length), { timeout: 5_000 }).toBe(paths.length);
});
