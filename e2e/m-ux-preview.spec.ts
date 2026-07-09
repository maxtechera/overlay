/**
 * e2e/m-ux-preview.spec.ts
 * Issue #32 acceptance checklist — "Preview UX: overlay on by default + slot-level boxes +
 * click-to-context + resizable panels" (part 1 of #28; demo-polish UX). All specs here are
 * keyless (@ux only, no @ai): the request-inspection spec aborts every outgoing model call the
 * same way e2e/m2b-artifacts.spec.ts's test 5 does, so it never needs ANTHROPIC_API_KEY.
 *
 * Acceptance items (issue #32):
 * 1. Overlay boxes visible immediately after extraction, no click
 * 2. Boxes are slot-level (title/subtitle/body distinctly boxed + labeled), not one box/component
 * 3. Clicking a slot box → composer chip; the next turn's request includes that element as context
 * 4. Dragging the divider changes the chat/preview split
 *
 * Tune target: maxtechera.dev only (CLAUDE.md). Its hero is headline+subhead only, no CTA slot
 * (CLAUDE.md Learnings, PR #20) — tests 1/2/3 rely on headline/subhead, not cta.
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

/** Overlay container is the div lib/runtime.ts's drawOverlay creates with zIndex 2147483646;
 *  its direct children are the individual slot boxes (or, rarely, a dashed node-level fallback
 *  box for a slot-less container). Returns each box's visible label text. */
async function overlayBoxLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const iframe = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement | null;
    const doc = iframe?.contentDocument;
    if (!doc) return [];
    const container = doc.querySelector("div[style*='2147483646']");
    if (!container) return [];
    return Array.from(container.children).map((c) => (c as HTMLElement).textContent?.trim() ?? "");
  });
}

/** Click the overlay box whose label starts with `slotPrefix` (case-insensitive) — a real DOM
 *  click dispatched inside the iframe, same evaluate-into-iframe pattern as
 *  e2e/m2b-artifacts.spec.ts test 6's heading click. Returns whether a matching box was found. */
async function clickOverlayBox(page: Page, slotPrefix: string): Promise<boolean> {
  return page.evaluate((prefix) => {
    const iframe = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement | null;
    const doc = iframe?.contentDocument;
    if (!doc) return false;
    const container = doc.querySelector("div[style*='2147483646']");
    if (!container) return false;
    const box = Array.from(container.children).find((c) =>
      (c as HTMLElement).textContent?.trim().toLowerCase().startsWith(prefix.toLowerCase())
    ) as HTMLElement | undefined;
    if (!box) return false;
    box.click();
    return true;
  }, slotPrefix);
}

// ── 1. Overlay boxes visible immediately after extraction, no click ────────────────────────

test("1 · overlay boxes are visible immediately after extraction, no click required @ux", async ({ page }) => {
  await submitAndWaitForExtraction(page);

  // Op controls (incl. the overlay toggle) only render once a hero is detected — same gate as
  // M1a. We never touch the toggle here; the auto-send after extraction is what we're proving.
  await expect(page.getByTestId("op-controls")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("overlay-btn")).toHaveText(/hide overlay/i);

  await expect.poll(() => overlayBoxLabels(page).then((l) => l.length), { timeout: 5_000 }).toBeGreaterThan(0);
});

// ── 2. Boxes are slot-level, not one box per component ──────────────────────────────────────

test("2 · overlay boxes are SLOT-level — the hero renders separate headline and subhead boxes, not one box for the whole component @ux", async ({
  page,
}) => {
  await submitAndWaitForExtraction(page);
  await expect.poll(() => overlayBoxLabels(page).then((l) => l.length), { timeout: 5_000 }).toBeGreaterThan(0);

  const labels = await overlayBoxLabels(page);
  const headlineBox = labels.find((l) => l.toLowerCase().startsWith("headline"));
  const subheadBox = labels.find((l) => l.toLowerCase().startsWith("subhead"));

  expect(headlineBox, `expected a distinct 'headline' box among: ${JSON.stringify(labels)}`).toBeTruthy();
  expect(subheadBox, `expected a distinct 'subhead' box among: ${JSON.stringify(labels)}`).toBeTruthy();
  expect(headlineBox, "headline and subhead must be genuinely separate boxes, not one node-level label").not.toBe(
    subheadBox
  );
});

// ── 3. Click a slot box → composer chip; next turn's request carries it as context ─────────

test("3 · clicking a slot box adds a composer chip; the next turn's outgoing request includes the selected element as context @ux", async ({
  page,
}) => {
  const agentRequests: { messages: unknown[] }[] = [];
  // Abort every call — we only need OUR OWN outgoing request payloads, never a real model
  // response (same keyless pattern as e2e/m2b-artifacts.spec.ts test 5).
  await page.route("**/api/anthropic/v1/messages", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { tools?: unknown[]; messages?: unknown[] };
    if (Array.isArray(body.tools)) agentRequests.push({ messages: body.messages ?? [] });
    await route.abort();
  });

  await submitAndWaitForExtraction(page);
  await expect.poll(() => overlayBoxLabels(page).then((l) => l.length), { timeout: 5_000 }).toBeGreaterThan(0);

  const clicked = await clickOverlayBox(page, "headline");
  expect(clicked, "a 'headline' overlay box exists to click on maxtechera.dev's hero").toBe(true);

  await expect(page.getByTestId("reference-chip")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("reference-chip")).toContainText(/selected: headline/i);

  const before = agentRequests.length;
  await page.getByTestId("prompt-input-textarea").fill("What do you think of this element?");
  await page.getByTestId("prompt-input-submit").click();
  await expect.poll(() => agentRequests.length, { timeout: 20_000 }).toBeGreaterThan(before);

  const latest = JSON.stringify(agentRequests.at(-1)!.messages);
  expect(latest, "outgoing request carries the selected-element marker").toContain("[selected element]");
  expect(latest, "outgoing request carries the selected slot name").toContain("slot=headline");
  // The chip's preview text is page-derived — must be fenced as untrusted (TECH-SPEC §6/§8).
  expect(latest, "selected element's preview text is fenced as untrusted page content").toContain("<<<PAGE");

  // Chip clears after send (same as the M2b "re:" reference-chip flow).
  await expect(page.getByTestId("reference-chip")).toHaveCount(0);
});

// ── 4. Resizable panels: dragging the divider changes the split ────────────────────────────

test("4 · dragging the divider widens the chat even after a site loads (pointer crosses the iframe) @ux", async ({ page }) => {
  await page.goto("/");
  // Load a site so the preview iframe is present — the "widen the chat" drag must survive the
  // pointer crossing onto the iframe (that's the real scenario; #32 review caught it dying there).
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("preview-iframe")).toBeVisible();

  const chat = page.locator(".chat");
  const divider = page.getByTestId("panel-divider");
  const before = await chat.evaluate((el) => el.getBoundingClientRect().width);

  const box = await divider.boundingBox();
  if (!box) throw new Error("panel-divider has no bounding box");

  // Drag RIGHT, deep into the preview iframe's area — pointer capture keeps the moves flowing.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const after = await chat.evaluate((el) => el.getBoundingClientRect().width);
  expect(after, `chat should widen dragging right over the iframe (before=${before}, after=${after})`).toBeGreaterThan(before);
});
