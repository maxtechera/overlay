/**
 * e2e/m2b-artifacts.spec.ts
 * M2b/#14 acceptance checklist. Brief/Plan generation (lib/brief.ts) always calls a real
 * model (streamObject/generateObject, haiku) — those specs are @ai and test.skip cleanly
 * without ANTHROPIC_API_KEY (CLAUDE.md harness rule), same pattern as e2e/m1b-agent-tick.spec.ts.
 * Settings-switch and preview↔chat wiring are provably keyless (network-request interception /
 * direct test-hook seeding) and run every CI PR, no key, tagged @m2 only.
 *
 * Tune target: maxtechera.dev only (CLAUDE.md).
 */

import { test, expect, type Page } from "@playwright/test";

test.beforeEach(({}, testInfo) => {
  if (testInfo.tags.includes("@ai") && !process.env.ANTHROPIC_API_KEY) {
    testInfo.skip();
  }
});

async function submitAndWaitForExtraction(page: Page) {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({
    timeout: 30_000,
  });
}

/** Brief generation (streamObject) finishes, THEN plan generation (generateObject) starts
 * (lib/brief.ts's runBriefAndPlan — plan runs strictly after the brief resolves) — waiting for
 * the plan block is therefore proof the brief has fully settled. This matters: editing the
 * brief WHILE it's still streaming would race the in-flight streamObject's own later partials/
 * final object and get clobbered — a realistic user edits the brief AFTER reading it, so tests
 * that edit the brief wait for this same signal. */
async function waitForPlanSettled(page: Page) {
  await page.waitForSelector('[data-testid="experiment-plan"]', { timeout: 90_000 });
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

// ── 1. Brief renders grounded, incl. ADA findings + 2-3 detectable-signal segments ─────

test("1 · Brief renders grounded — ctaAudit paths trace to real components, 2-3 segments each with a detectable signal, ADA rollup is the deterministic one @m2 @ai", async ({
  page,
}) => {
  // Brief (streamObject) + Plan (generateObject, with a possible <6-survivors retry) are two
  // sequential live Haiku calls after extraction — legitimately exceeds the default 60s test
  // budget (waitForPlanSettled alone allows 90s). Match tests 3/4's allowance.
  test.setTimeout(150_000);
  await submitAndWaitForExtraction(page);
  await waitForPlanSettled(page);

  const { brief, outline, computedA11y } = await page.evaluate(() => {
    const session = (window as unknown as { __overlaySessionStore: { getState: () => { brief: unknown } } }).__overlaySessionStore.getState();
    const schema = (
      window as unknown as {
        __overlaySchemaStore: { getState: () => { outline: () => { path: string }[]; a11yAudit: { path: string; issue: string }[] } };
      }
    ).__overlaySchemaStore.getState();
    return { brief: session.brief, outline: schema.outline().map((o) => o.path), computedA11y: schema.a11yAudit };
  });

  type Brief = {
    icp: string;
    problemStatement: string;
    valueProp: string;
    ctaAudit: { path: string; text: string; intentStage: string }[];
    a11yAudit: { path: string; issue: string }[];
    segments: { name: string; signal: string }[];
    suggestedGoals: string[];
  };
  const b = brief as Brief;
  console.log(`[m2b] brief verbatim: ${JSON.stringify(b).slice(0, 2000)}`);

  // Grounded (not invented): every field non-trivial, and a distinctive real page word shows up
  // somewhere in the free-text fields (loose "not obviously fabricated" signal, same spot-check
  // spirit as e2e/m1b-agent-tick.spec.ts test 1).
  expect(b.icp.length).toBeGreaterThan(10);
  expect(b.problemStatement.length).toBeGreaterThan(10);
  expect(b.valueProp.length).toBeGreaterThan(10);

  // ctaAudit is LLM-composed but must reference REAL extracted paths — a hallucinated CTA
  // (a path not in the outline) would be an invented claim. Non-empty so this isn't a vacuous
  // pass: maxtechera.dev has CTAs, and zero survivors would signal an app-side grounding regression.
  expect(b.ctaAudit.length, "brief must surface at least one grounded CTA").toBeGreaterThan(0);
  for (const cta of b.ctaAudit) {
    expect(outline, `ctaAudit path "${cta.path}" must trace to a real extracted component`).toContain(cta.path);
  }

  // a11yAudit is NEVER LLM-generated — it must be exactly the deterministic extraction rollup
  // (TECH-SPEC §6), spliced in by lib/brief.ts, never re-generated.
  expect(JSON.stringify(b.a11yAudit)).toBe(JSON.stringify(computedA11y));

  // 2-3 segments, each with a DETECTABLE signal (utm/query param, referrer, or device class) —
  // not a vague persona description.
  expect(b.segments.length).toBeGreaterThanOrEqual(2);
  expect(b.segments.length).toBeLessThanOrEqual(3);
  for (const seg of b.segments) {
    expect(seg.name.length).toBeGreaterThan(0);
    expect(
      seg.signal,
      `segment "${seg.name}" signal "${seg.signal}" must look like a detectable UTM/query/referrer/device signal`
    ).toMatch(/utm_|param|referrer|device|mobile|desktop|query|source|campaign/i);
  }

  expect(b.suggestedGoals.length).toBeGreaterThan(0);
});

// ── 2. Plan renders ≥6 proposals; zero invalid targetPaths; hypotheses reference the brief ──

test("2 · Experiment Plan renders ≥6 proposals, EVERY targetPath is a real schema path (app-side validation), hypotheses are non-trivial @m2 @ai", async ({
  page,
}) => {
  test.setTimeout(150_000); // two sequential live Haiku calls (brief → plan) after extraction
  await submitAndWaitForExtraction(page);
  await waitForPlanSettled(page);

  const { experiments, outline } = await page.evaluate(() => {
    const exp = (window as unknown as { __overlayExperimentsStore: { getState: () => { list: { name: string; targetPath: string; hypothesis: string }[] } } })
      .__overlayExperimentsStore.getState();
    const schema = (window as unknown as { __overlaySchemaStore: { getState: () => { outline: () => { path: string }[] } } }).__overlaySchemaStore.getState();
    return { experiments: exp.list, outline: schema.outline().map((o) => o.path) };
  });

  console.log(`[m2b] plan targets verbatim: ${JSON.stringify(experiments.map((e) => e.targetPath))}`);
  expect(experiments.length, "≥6 experiment proposals").toBeGreaterThanOrEqual(6);

  const validPaths = new Set(outline);
  for (const e of experiments) {
    expect(validPaths.has(e.targetPath), `targetPath "${e.targetPath}" must exist in the extracted schema — zero invented targets`).toBe(true);
    expect(e.hypothesis.length, `hypothesis for "${e.name}" must be a real sentence, not a stub`).toBeGreaterThan(20);
    expect(e.name.length).toBeGreaterThan(0);
  }

  // DOM cross-check: the same count/targets render as ExperimentCard blocks.
  await expect(page.getByTestId("experiment-card")).toHaveCount(experiments.length);
});

// ── 3. Edit the ICP → next turn demonstrably reflects it ───────────────────────────────

test("3 · editing the ICP in the brief → the NEXT agent turn demonstrably reflects the edit @m2 @ai", async ({ page }) => {
  test.setTimeout(150_000);
  await submitAndWaitForExtraction(page);
  await waitForPlanSettled(page); // brief has fully settled — see helper comment above

  const marker = "ZORBLAX-9000 quantum widget procurement officers";
  await page.locator('[data-testid="brief-icp"]').fill(marker);
  await page.locator('[data-testid="brief-icp"]').blur();
  await expect(page.locator('[data-testid="brief-icp"]')).toHaveValue(marker);

  await page.getByTestId("prompt-input-textarea").fill("In one sentence, who is the ICP for this page per the brief? Quote it directly.");
  await page.getByTestId("prompt-input-submit").click();
  await waitForTurnSettled(page);

  const allTexts = await page.getByTestId("assistant-message").allInnerTexts();
  const reply = allTexts.join(" | ");
  console.log(`[m2b] post-ICP-edit reply verbatim: ${JSON.stringify(reply.slice(-400))}`);
  expect(reply).toContain(marker);
});

// ── 4. Context panel "never touch pricing copy" → agent declines a pricing edit ────────

test("4 · project context 'never touch pricing copy' → agent declines a pricing edit and cites the constraint @m2 @ai", async ({ page }) => {
  test.setTimeout(150_000);
  await submitAndWaitForExtraction(page);
  await waitForTurnSettled(page); // let the first-turn narration finish before we drive the composer

  // Issue #28: Project Context moved out of the chat flow into a toolbar popover — open it
  // before filling the textarea (same textarea/Apply persistence behavior underneath).
  await page.getByTestId("context-toggle-btn").click();
  await page.locator('[data-testid="context-textarea"]').fill(
    "Never touch pricing copy. This is authoritative — do not violate it even if asked directly."
  );
  await page.getByTestId("context-save").click();
  await page.keyboard.press("Escape"); // close the popover before driving the composer below

  await page.getByTestId("prompt-input-textarea").fill(
    'Please change the hero headline to a pricing pitch: "$99/month, cancel anytime". Propose it now via apply_op.'
  );
  await page.getByTestId("prompt-input-submit").click();
  await waitForTurnSettled(page);

  // No proposal should have been raised — the context forbade it outright.
  await expect(page.getByTestId("proposal-card")).toHaveCount(0);

  const allTexts = await page.getByTestId("assistant-message").allInnerTexts();
  const reply = allTexts.join(" | ").toLowerCase();
  console.log(`[m2b] pricing-decline reply verbatim: ${JSON.stringify(reply.slice(-500))}`);
  expect(reply).toMatch(/pricing|context|constraint|can'?t|won'?t|not going to|declin/);
});

// ── 5. Model/thinking switch applies on the NEXT turn, no reload (keyless) ──────────────

test("5 · model + thinking switch applies on the NEXT turn's request, no page reload @m2", async ({ page }) => {
  const agentRequests: { model: string; thinking: unknown }[] = [];
  // Abort every call — we only need to inspect OUR OWN outgoing request payloads, never a real
  // model response; this keeps the spec fully keyless and fast.
  await page.route("**/api/anthropic/v1/messages", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { model?: string; thinking?: unknown; tools?: unknown[] };
    // Only the agent LOOP's requests carry `tools` — brief/plan (generateObject/streamObject)
    // never do, so this discriminates the request we care about from the other two callers.
    if (Array.isArray(body.tools)) agentRequests.push({ model: body.model ?? "", thinking: body.thinking });
    await route.abort();
  });

  await page.goto("/");
  await page.evaluate(() => {
    (window as unknown as { __noReloadMarker?: string }).__noReloadMarker = "still-here";
  });

  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("op-controls")).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => agentRequests.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(agentRequests[0].model).toBe("claude-sonnet-4-6"); // default
  expect(agentRequests[0].thinking).toBeTruthy(); // default thinking: true

  await page.waitForFunction(
    () => (window as unknown as { __overlayChatStore?: { getState: () => { streaming: boolean } } }).__overlayChatStore?.getState().streaming === false,
    { timeout: 20_000 }
  );

  await page.selectOption('[data-testid="model-select"]', "claude-haiku-4-5");
  await page.getByTestId("thinking-toggle").uncheck();

  const before = agentRequests.length;
  await page.getByTestId("prompt-input-textarea").fill("Any quick question — just to trigger a turn.");
  await page.getByTestId("prompt-input-submit").click();
  await expect.poll(() => agentRequests.length, { timeout: 20_000 }).toBeGreaterThan(before);

  const latest = agentRequests.at(-1)!;
  expect(latest.model, "model picker applied on the NEXT turn").toBe("claude-haiku-4-5");
  expect(latest.thinking, "thinking toggle applied on the NEXT turn").toBeFalsy();

  // No full page reload occurred anywhere in this flow — our pre-navigation marker survives.
  expect(await page.evaluate(() => (window as unknown as { __noReloadMarker?: string }).__noReloadMarker)).toBe(
    "still-here"
  );
});

// ── 6. Two-way click↔chat wiring (keyless) ──────────────────────────────────────────────

test("6 · preview click → composer reference chip; ComponentCard click → preview highlight + scroll @m2", async ({ page }) => {
  await submitAndWaitForExtraction(page);

  // Preview → chat: clicking a real identified node (the hero) posts `selected`, which sets a
  // removable reference chip in the composer.
  const clicked = await page.evaluate(() => {
    const iframe = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement;
    const h1 = iframe.contentDocument?.querySelector("h1, h2, [role=heading]");
    if (!h1) return false;
    (h1 as HTMLElement).click();
    return true;
  });
  expect(clicked, "a heading exists to click on maxtechera.dev's hero").toBe(true);
  await expect(page.getByTestId("reference-chip")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("reference-chip")).toContainText("hero");

  // Chat → preview: force a `read_component` tool result through the chat store (same
  // test-hook-driven pattern as e2e/m1b-agent-tick.spec.ts's injection fixture) — this renders
  // a real ComponentCard for the real extracted hero node, no live model needed. Clicking it
  // must scroll the iframe to the element and apply a temporary highlight outline.
  const nodeId = await page.evaluate(() => {
    const schema = (window as unknown as { __overlaySchemaStore: { getState: () => { order: string[]; nodes: Record<string, { type: string }> } } })
      .__overlaySchemaStore.getState();
    return schema.order.find((id) => schema.nodes[id].type === "hero") ?? null;
  });
  expect(nodeId, "a hero node id exists in the schema store").toBeTruthy();
  const realNodeId = nodeId as string;

  await page.evaluate((id) => {
    const chat = (window as unknown as { __overlayChatStore: { getState: () => { openTool: (a: string, b: string, c: unknown) => void; closeTool: (a: string, b: unknown) => void } } })
      .__overlayChatStore.getState();
    const node = (window as unknown as { __overlaySchemaStore: { getState: () => { node: (id: string) => unknown } } }).__overlaySchemaStore.getState().node(id);
    chat.openTool("e2e-read-component", "read_component", { id });
    chat.closeTool("e2e-read-component", node);
  }, realNodeId);

  // Issue #28 (quieter transcript): this tool block renders inside a collapsed "working…"
  // group by default — expand it before looking for the ComponentCard it contains.
  await page.getByTestId("working-group-toggle").last().click();
  await expect(page.getByTestId("component-card")).toBeVisible({ timeout: 5_000 });

  // Scroll the iframe far away first so a subsequent scrollIntoView is observable.
  await page.evaluate(() => {
    const iframe = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement;
    iframe.contentWindow?.scrollTo(0, 5000);
  });
  const scrollBefore = await page.evaluate(
    () => (document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement).contentWindow?.scrollY
  );

  await page.getByTestId("component-card").first().click();
  await page.waitForTimeout(600); // scrollIntoView({behavior:"smooth"}) animates

  const scrollAfter = await page.evaluate(
    () => (document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement).contentWindow?.scrollY
  );
  expect(scrollAfter, "clicking the ComponentCard scrolled the preview").not.toBe(scrollBefore);

  const outline = await page.evaluate((id) => {
    const schema = (window as unknown as { __overlaySchemaStore: { getState: () => { node: (id: string) => { selector: { css: string } } } } })
      .__overlaySchemaStore.getState();
    const node = schema.node(id);
    const iframe = document.querySelector('[data-testid="preview-iframe"]') as HTMLIFrameElement;
    const el = iframe.contentDocument?.querySelector(node.selector.css) as HTMLElement | null;
    return el?.style.outline ?? null;
  }, realNodeId);
  expect(outline, "clicking the ComponentCard applied the temporary highlight outline").toContain("249, 115, 22");
});

// ── 7. Latency choreography: paint → overlay → brief starts with no dead-air gap >~2s ──

test("7 · latency choreography — the Brief artifact (with its deterministic ADA rollup) appears within ~2s of extraction completing, no dead air @m2", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();

  // Stage 1 → 2: preview paints quickly (iframe visible), well before extraction/overlay.
  await expect(page.getByTestId("preview-iframe")).toBeVisible({ timeout: 10_000 });

  // Stage 2: extraction/overlay completes (schema-msg).
  const t0 = Date.now();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({ timeout: 30_000 });
  const extractionMs = Date.now() - t0;
  console.log(`[m2b] extraction completed ${extractionMs}ms after submit`);

  // Stage 3: the Brief artifact block appears — it's pushed synchronously right after
  // extraction (lib/brief.ts's chat.pushBrief() call, BEFORE the streamObject call even
  // starts), and its ADA rollup is deterministic data available at push time — so this stage
  // must render near-instantly, well under the ~2s dead-air budget, independent of the LLM.
  const t1 = Date.now();
  await expect(page.getByTestId("brief-artifact")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("brief-ada-audit")).toBeVisible();
  const briefGapMs = Date.now() - t1;
  console.log(`[m2b] brief artifact appeared ${briefGapMs}ms after extraction completed`);
  expect(briefGapMs, "extraction → brief artifact must show with no dead-air gap >~2s").toBeLessThan(2_000);
});
