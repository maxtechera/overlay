/**
 * e2e/m-ux-chat-variants.spec.ts
 * Issue #28 acceptance checklist — chat/variants UX polish (part 2 of the #28/#32 UX pass;
 * the preview side shipped in #32/#33). All four items here are fully KEYLESS: the Anthropic
 * account is out of credits (issue #28 note) so nothing here drives a live model turn — the
 * context toolbar, transcript coalescing, create_variant's app-side clamp, and the carousel's
 * navigation/Apply mechanics are all deterministic app logic, proven the same way M3's
 * warn-only/thumbnail/tab-switch specs are (direct store seeding + real DOM assertions,
 * CLAUDE.md harness rule). The agent-COPY-STEERING half of item 3 (lib/prompts.ts asking for
 * fewer/smaller variants) is prompt text only — code-reviewed, not exercised by a spec, per
 * the out-of-credits note.
 *
 * Tune target: maxtechera.dev only (CLAUDE.md) — only item 4 touches a live page at all (to
 * exercise the real apply/revert pipeline against a real hero node); items 1-3 need no page.
 */

import { test, expect } from "@playwright/test";

// ── 1 · Project Context lives in a toolbar popover, not the chat flow ───────────────────

test("1 · Project Context opens from a toolbar control, not the chat flow — and persists @ux", async ({ page }) => {
  await page.goto("/");

  // Genuinely NOT in the chat flow: no textarea anywhere until the toolbar control is opened.
  await expect(page.getByTestId("context-textarea")).toHaveCount(0);
  const toggle = page.getByTestId("context-toggle-btn");
  await expect(toggle).toBeVisible();
  const livesOutsideChatColumn = await toggle.evaluate((el) => !el.closest(".chat"));
  expect(livesOutsideChatColumn, "the toolbar control is not inside the .chat column").toBe(true);

  await toggle.click();
  await expect(page.getByTestId("context-panel")).toBeVisible();
  await expect(page.getByTestId("context-textarea")).toBeVisible();

  const marker = "Issue-28 toolbar marker: never touch pricing copy";
  await page.getByTestId("context-textarea").fill(marker);
  await page.getByTestId("context-save").click();

  // Persisted to the real session store (TECH-SPEC §9's context field), not just local popover
  // state — the same store buildSystem() reads every turn.
  const stored = await page.evaluate(
    () => (window as unknown as { __overlaySessionStore: { getState: () => { context: string } } }).__overlaySessionStore.getState().context
  );
  expect(stored).toBe(marker);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("context-textarea")).toHaveCount(0);

  // Reopening ("on demand") shows the persisted value, not a blank slate.
  await toggle.click();
  await expect(page.getByTestId("context-textarea")).toHaveValue(marker);
});

// ── 2 · Tool/reasoning noise coalesces into one expandable "working" line ───────────────

test("2 · consecutive tool/reasoning blocks coalesce into ONE collapsed 'working' line; expanding reveals the rows @ux", async ({ page }) => {
  await page.goto("/");

  // Drive several tool + reasoning blocks into the chat store directly (deterministic test
  // hook — same pattern as m3-variants.spec.ts seeding the variants/experiments stores).
  await page.evaluate(() => {
    const chat = (window as unknown as { __overlayChatStore: { setState: (s: unknown) => void } }).__overlayChatStore;
    chat.setState({
      blocks: [
        { kind: "tool", id: "t1", toolCallId: "c1", name: "list_components", input: {}, output: [], status: "done", startedAt: 0, durationMs: 4 },
        { kind: "reasoning", id: "r1", text: "Looking at the hero section for a conviction angle…", streaming: false },
        { kind: "tool", id: "t2", toolCallId: "c2", name: "read_component", input: { id: "n1" }, output: { id: "n1" }, status: "done", startedAt: 0, durationMs: 7 },
        { kind: "text", id: "x1", role: "assistant", text: "Here's what I found on the hero." },
      ],
    });
  });

  // ONE working group for the 3 consecutive noise blocks; the assistant text stays its own,
  // fully prominent block (never swallowed into the group).
  await expect(page.getByTestId("working-group")).toHaveCount(1);
  await expect(page.getByTestId("working-group-toggle")).toContainText("3 steps");
  await expect(page.getByTestId("assistant-message")).toHaveCount(1);
  await expect(page.getByTestId("assistant-message")).toContainText("Here's what I found on the hero.");

  // Collapsed by default: the underlying rows are not rendered until expanded.
  await expect(page.getByTestId("tool-row")).toHaveCount(0);
  await expect(page.getByTestId("reasoning-block")).toHaveCount(0);

  await page.getByTestId("working-group-toggle").click();
  await expect(page.getByTestId("tool-row")).toHaveCount(2);
  await expect(page.getByTestId("reasoning-block")).toHaveCount(1);
  await expect(page.getByTestId("reasoning-block")).toContainText("conviction angle");

  // Collapsing again hides them again — a real toggle, not a one-way reveal.
  await page.getByTestId("working-group-toggle").click();
  await expect(page.getByTestId("tool-row")).toHaveCount(0);
  await expect(page.getByTestId("reasoning-block")).toHaveCount(0);
});

test("2b · a lone proposal/brief/gallery block is never swallowed into a working group @ux", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const chat = (window as unknown as { __overlayChatStore: { setState: (s: unknown) => void } }).__overlayChatStore;
    chat.setState({
      blocks: [
        { kind: "tool", id: "t1", toolCallId: "c1", name: "list_components", input: {}, output: [], status: "done", startedAt: 0, durationMs: 4 },
        { kind: "brief", id: "b1" },
        { kind: "tool", id: "t2", toolCallId: "c2", name: "read_component", input: {}, output: {}, status: "done", startedAt: 0, durationMs: 4 },
      ],
    });
  });

  // Two SEPARATE working groups (one on either side of the brief), never one merged group —
  // grouping only ever touches contiguous tool/reasoning runs.
  await expect(page.getByTestId("working-group")).toHaveCount(2);
  await expect(page.getByTestId("working-group-toggle").first()).toContainText("1 step");
});

// ── 3 · create_variant clamped at 4 arms per experiment (keyless — the real tool, not a mock) ──

test("3 · create_variant clamps at 4 arms per experiment — a 5th call is ignored, not created @ux", async ({ page }) => {
  await page.goto("/");

  const outputs = await page.evaluate(async () => {
    type Tools = {
      create_variant: {
        execute: (input: { name: string; experimentId?: string }, opts: { toolCallId: string }) => Promise<unknown>;
      };
    };
    type MakeTools = (deps: { send: (m: unknown) => Promise<unknown> }) => Tools;
    const win = window as unknown as { __overlayMakeTools: MakeTools };
    // Never actually invoked in this flow (no ops exist on any freshly-created variant, so
    // switchActiveVariant's revert/replay loops are both empty) — a rejecting stub is enough.
    const tools = win.__overlayMakeTools({ send: () => Promise.reject(new Error("not used")) });
    const results: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await tools.create_variant.execute({ name: `Angle ${i + 1}`, experimentId: "exp-clamp-test" }, { toolCallId: `tc-${i}` }));
    }
    return results;
  });

  console.log(`[ux] create_variant clamp outputs verbatim: ${JSON.stringify(outputs)}`);
  expect(outputs).toHaveLength(5);
  for (const o of outputs.slice(0, 4)) {
    expect((o as { created?: boolean }).created, "the first 4 calls each create an arm").toBe(true);
  }
  const fifth = outputs[4] as { created?: boolean; reason?: string };
  expect(fifth.created, "the 5th call for the SAME experiment is ignored, not created").toBe(false);
  expect(fifth.reason ?? "").toMatch(/max 4/i);

  const armCount = await page.evaluate(
    () =>
      (window as unknown as { __overlayVariantsStore: { getState: () => { list: { experimentId?: string }[] } } }).__overlayVariantsStore
        .getState()
        .list.filter((v) => v.experimentId === "exp-clamp-test").length
  );
  expect(armCount, "exactly 4 arms exist for this experiment, never 5").toBe(4);
});

test("3b · the clamp scopes independently per experiment — a different experimentId still gets its own 4 @ux", async ({ page }) => {
  await page.goto("/");

  const secondExpCount = await page.evaluate(async () => {
    type Tools = { create_variant: { execute: (input: { name: string; experimentId?: string }, opts: { toolCallId: string }) => Promise<unknown> } };
    type MakeTools = (deps: { send: (m: unknown) => Promise<unknown> }) => Tools;
    const win = window as unknown as { __overlayMakeTools: MakeTools };
    const tools = win.__overlayMakeTools({ send: () => Promise.reject(new Error("not used")) });
    for (let i = 0; i < 4; i++) {
      await tools.create_variant.execute({ name: `Exp1 Angle ${i + 1}`, experimentId: "exp-A" }, { toolCallId: `a-${i}` });
    }
    // A different experiment's arms are a separate scope — not blocked by exp-A's cap.
    const r = await tools.create_variant.execute({ name: "Exp2 Angle 1", experimentId: "exp-B" }, { toolCallId: "b-0" });
    return r as { created?: boolean };
  });
  expect(secondExpCount.created, "a fresh experiment scope is unaffected by another experiment's cap").toBe(true);
});

// ── 4 · Variant carousel: prev/next + dots, per-slide Apply switches the live preview ────

test("4 · Variant carousel — ranked by delta, prev/next+dots navigate, Apply switches the active variant on the preview @ux", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({ timeout: 30_000 });

  const heroId = await page.evaluate(() => {
    const schema = (window as unknown as { __overlaySchemaStore: { getState: () => { order: string[]; nodes: Record<string, { type: string }> } } })
      .__overlaySchemaStore.getState();
    return schema.order.find((id) => schema.nodes[id].type === "hero") ?? null;
  });
  expect(heroId, "a hero node id exists").toBeTruthy();

  const MARKER_A = "UX-CAROUSEL-VARIANT-A";
  const MARKER_B = "UX-CAROUSEL-VARIANT-B";

  // Seed two ad-hoc (no experimentId) variants, each with ONE real applied-shape op targeting
  // the real hero — Apply below drives switchActiveVariant, which does the actual apply-op
  // round-trip against the live iframe (same mechanics m3-variants.spec.ts's tab-switch test
  // proves; here it's driven by the carousel's Apply button instead of a variant tab).
  await page.evaluate(
    ({ heroId, markerA, markerB }) => {
      const opA = { op: "update-content", target: heroId, slots: { headline: { text: markerA } }, rationale: "ux carousel test A" };
      const opB = { op: "update-content", target: heroId, slots: { headline: { text: markerB } }, rationale: "ux carousel test B" };
      type Store<S> = { setState: (s: Partial<S>) => void };
      const variants = (window as unknown as { __overlayVariantsStore: Store<{ list: unknown[]; activeId: string }> }).__overlayVariantsStore;
      variants.setState({
        list: [
          {
            id: "v-a",
            name: "Angle A",
            goal: "g",
            ops: [{ id: "vop-a", source: "human", op: opA, status: "applied" }],
            score: { control: 0.4, variant: 0.55, delta: 0.15, confidence: 0.7, reasons: [] },
          },
          {
            id: "v-b",
            name: "Angle B",
            goal: "g",
            ops: [{ id: "vop-b", source: "human", op: opB, status: "applied" }],
            score: { control: 0.4, variant: 0.45, delta: 0.05, confidence: 0.6, reasons: [] },
          },
        ],
        activeId: "control",
      });
      (window as unknown as { __overlayChatStore: { getState: () => { pushGallery: () => void } } }).__overlayChatStore.getState().pushGallery();
    },
    { heroId: heroId as string, markerA: MARKER_A, markerB: MARKER_B }
  );

  await expect(page.getByTestId("variant-gallery")).toBeVisible();
  await expect(page.getByTestId("carousel-dot")).toHaveCount(2);

  // Ranked by delta: Angle A (+0.15) shows first.
  await expect(page.getByTestId("variant-name")).toHaveText("Angle A");
  await expect(page.getByTestId("carousel-dot").nth(0)).toHaveAttribute("data-active", "true");

  // Apply the first slide -> the live preview shows variant A's headline (a REAL apply-op
  // round-trip through switchActiveVariant, not a store-only flip).
  await page.getByTestId("variant-apply-btn").click();
  await expect
    .poll(() =>
      page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim())
    )
    .toBe(MARKER_A);
  expect(await page.evaluate(() => (window as unknown as { __overlayVariantsStore: { getState: () => { activeId: string } } }).__overlayVariantsStore.getState().activeId)).toBe(
    "v-a"
  );

  // Next -> Angle B's slide; Apply there reverts A and replays B on the SAME live preview.
  await page.getByTestId("carousel-next").click();
  await expect(page.getByTestId("variant-name")).toHaveText("Angle B");
  await expect(page.getByTestId("carousel-dot").nth(1)).toHaveAttribute("data-active", "true");

  await page.getByTestId("variant-apply-btn").click();
  await expect
    .poll(() =>
      page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => el.contentDocument?.querySelector("h1, h2, [role=heading]")?.textContent?.trim())
    )
    .toBe(MARKER_B);
  expect(await page.evaluate(() => (window as unknown as { __overlayVariantsStore: { getState: () => { activeId: string } } }).__overlayVariantsStore.getState().activeId)).toBe(
    "v-b"
  );

  // Prev navigates back to Angle A's slide (dots + prev/next both work, not just next).
  await page.getByTestId("carousel-prev").click();
  await expect(page.getByTestId("variant-name")).toHaveText("Angle A");

  // Dots jump directly too.
  await page.getByTestId("carousel-dot").nth(1).click();
  await expect(page.getByTestId("variant-name")).toHaveText("Angle B");
});
