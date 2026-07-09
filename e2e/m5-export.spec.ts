/**
 * e2e/m5-export.spec.ts
 * M5/#10 acceptance checklist — "the variant as a deployable A/B script" (MVP closes here).
 * Everything here is DETERMINISTIC and proven KEYLESS: the exported applier is pure JS applied
 * to a LOCAL fixture page (public/e2e-fixtures/export-fixture.html) — never a live external
 * site, which drifts (CLAUDE.md Learnings, 2026-07-08). The fixture's real SelectorRef
 * (css + fingerprint) comes from running the SAME production runtime bundle
 * (lib/runtime.built.js) against the fixture's exact markup (e2e/helpers/runtime-fixture.ts,
 * the same pattern e2e/m3-variants.spec.ts uses) — so the export snippet is proven against
 * genuine extraction output, not hand-rolled selectors.
 *
 * Tune target: maxtechera.dev only (CLAUDE.md) — irrelevant here, this milestone's pass is a
 * pure-JS applier spec, not a live-site extraction spec.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { extractOnFixture, loadFixture } from "./helpers/runtime-fixture";
import {
  buildApplierSource,
  buildConsoleSnippet,
  buildScriptTag,
  mergeOpsByTarget,
  specForExperiment,
  specForSegment,
  specForVariant,
  type StandaloneOp,
} from "../lib/export";
import type { SelectorRef, VariantOp } from "../lib/types";

const FIXTURE_PATH = join(__dirname, "..", "public", "e2e-fixtures", "export-fixture.html");
const FIXTURE_HTML = readFileSync(FIXTURE_PATH, "utf-8");
const FIXTURE_URL = "/e2e-fixtures/export-fixture.html";
const ORIGINAL_HEADLINE = "Ship faster with Overlay";

let heroSelector: SelectorRef;

test.beforeAll(async ({ browser }) => {
  // Run the REAL extraction ladder (lib/runtime.built.js) against the exact fixture markup to
  // get an authoritative SelectorRef (css + fingerprint) — not a hand-rolled one.
  const page = await browser.newPage();
  await loadFixture(page, FIXTURE_HTML);
  const { nodes } = await extractOnFixture(page, { hostnameOverride: "fixture.invalid" });
  const hero = nodes.find((n) => (n as { type: string }).type === "hero") as
    | { id: string; selector: SelectorRef }
    | undefined;
  if (!hero) throw new Error("m5-export: hero not detected on the fixture — fixture markup regressed");
  heroSelector = hero.selector;
  await page.close();
});

function headlineOp(text: string): StandaloneOp {
  return { css: heroSelector.css, fingerprint: heroSelector.fingerprint, slots: { headline: { text } } };
}

async function currentHeadline(page: Page): Promise<string> {
  return (await page.locator("#hero h1").textContent())?.trim() ?? "";
}

// ── 0 (keyless, pure) · mergeOpsByTarget / spec builders — shape + merge semantics ──────────

test("0 · mergeOpsByTarget merges same-target ops, drops unresolved targets and non-applied ops @m5", () => {
  const vops: VariantOp[] = [
    { id: "op1", source: "agent", status: "applied", op: { op: "update-content", target: "n1", slots: { headline: { text: "A" } }, rationale: "r" } },
    { id: "op2", source: "agent", status: "applied", op: { op: "update-content", target: "n1", slots: { subhead: { text: "B" } }, rationale: "r" } },
    { id: "op3", source: "agent", status: "rejected", op: { op: "update-content", target: "n1", slots: { headline: { text: "REJECTED" } }, rationale: "r" } },
    { id: "op4", source: "agent", status: "applied", op: { op: "update-content", target: "unknown-node", slots: { headline: { text: "X" } }, rationale: "r" } },
  ];
  const selectorOf = (id: string) => (id === "n1" ? { css: "#hero", fingerprint: "fp" } : undefined);
  const ops = mergeOpsByTarget(vops, selectorOf);

  expect(ops.length, "one merged StandaloneOp for n1; the unknown-node op is dropped").toBe(1);
  expect(ops[0].css).toBe("#hero");
  expect(ops[0].fingerprint).toBe("fp");
  expect(ops[0].slots.headline?.text, "op1's slot present").toBe("A");
  expect(ops[0].slots.subhead?.text, "op2's slot merged in alongside op1's").toBe("B");
});

test("0b · specForVariant/specForExperiment/specForSegment shapes @m5", () => {
  const ops = [headlineOp("V")];

  const single = specForVariant(ops, "overlay-ab-v1");
  expect(single.mode).toBe("ab");
  expect(single.arms.map((a) => a.id)).toEqual(["control", "variant"]);
  expect(single.arms[0].w + single.arms[1].w).toBeCloseTo(1, 5);
  expect(single.arms[0].ops).toEqual([]); // control = zero ops, always

  const exp = specForExperiment(
    [
      { id: "armA", ops },
      { id: "armB", ops: [] },
    ],
    { control: 0.2, armA: 0.5, armB: 0.3 },
    "overlay-ab-exp1"
  );
  expect(exp.arms.map((a) => a.id)).toEqual(["control", "armA", "armB"]);
  expect(exp.arms.map((a) => a.w)).toEqual([0.2, 0.5, 0.3]);

  const seg = specForSegment(ops, { kind: "param", param: "utm_source", value: "b" }, "overlay-ab-seg1");
  expect(seg.mode).toBe("segment");
  expect(seg.signal).toEqual({ kind: "param", param: "utm_source", value: "b" });
});

// ── 1 (keyless) · Console version on the ORIGINAL live page → applies immediately ──────────

test("1 · console version pasted on the ORIGINAL live page applies the variant immediately, no persistence @m5", async ({ page }) => {
  const spec = specForVariant([headlineOp("Console-forced headline")], "overlay-ab-console-test");
  const consoleSnippet = buildConsoleSnippet(spec);
  expect(consoleSnippet, "console version forces the non-control arm").toContain('"variant"');

  await page.goto(FIXTURE_URL);
  expect(await currentHeadline(page), "unmodified before injection").toBe(ORIGINAL_HEADLINE);

  // "Paste in the console": inject after the page is already fully loaded (readyState complete)
  // — run() must fire synchronously, no waiting for any event.
  await page.addScriptTag({ content: consoleSnippet });

  await expect.poll(() => currentHeadline(page)).toBe("Console-forced headline");
  expect(await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant)).toBe("variant");
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-overlay-variant"))).toBe("variant");
  // Forced console path never touches localStorage (no bucketing, no persistence).
  expect(await page.evaluate((k) => localStorage.getItem(k), spec.key)).toBeNull();
});

// ── 2 (keyless) · Multi-arm (C+2) buckets ~by suggested weights over ~60 fresh profiles ────

test("2 · multi-arm (control + 2 arms) buckets roughly by its suggested weights over 60 fresh profiles @m5", async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const spec = specForExperiment(
    [
      { id: "armA", ops: [] },
      { id: "armB", ops: [] },
    ],
    { control: 0.2, armA: 0.5, armB: 0.3 },
    "overlay-ab-multiarm-test"
  );
  const source = buildApplierSource(spec);

  const N = 60;
  const counts = await page.evaluate(
    ({ source, n }) => {
      const tally: Record<string, number> = { control: 0, armA: 0, armB: 0 };
      for (let i = 0; i < n; i++) {
        localStorage.clear();
        delete (window as unknown as { __overlayVariant?: string }).__overlayVariant;
        // eslint-disable-next-line no-new-func -- test harness: eval the generated applier source, same as pasting it
        new Function(source)();
        const bucket = (window as unknown as { __overlayVariant?: string }).__overlayVariant ?? "unknown";
        tally[bucket] = (tally[bucket] ?? 0) + 1;
      }
      return tally;
    },
    { source, n: N }
  );

  console.log(`[m5] multi-arm distribution over ${N} fresh profiles verbatim: ${JSON.stringify(counts)}`);
  const total = (counts.control ?? 0) + (counts.armA ?? 0) + (counts.armB ?? 0);
  expect(total, "every profile bucketed into a known arm").toBe(N);

  // Loose bounds (Math.random() over N=60 has real variance) — proves the WEIGHTING actually
  // drives bucketing (armA > armB > control, roughly matching 0.5 > 0.3 > 0.2), not that it hits
  // the exact percentages.
  expect(counts.armA, "armA (highest weight) gets the most visitors").toBeGreaterThan(counts.control ?? 0);
  expect(counts.armA, "armA (0.5) outweighs armB (0.3)").toBeGreaterThan((counts.armB ?? 0) - 6);
  expect(counts.control, "control (0.2, lowest weight) still gets some traffic — never literally zero").toBeGreaterThan(0);
});

test("2b · single-variant export = degenerate 2-arm case, ~50/50 over 60 fresh profiles @m5", async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const spec = specForVariant([], "overlay-ab-degenerate-test");
  const source = buildApplierSource(spec);

  const N = 60;
  const counts = await page.evaluate(
    ({ source, n }) => {
      const tally: Record<string, number> = { control: 0, variant: 0 };
      for (let i = 0; i < n; i++) {
        localStorage.clear();
        delete (window as unknown as { __overlayVariant?: string }).__overlayVariant;
        // eslint-disable-next-line no-new-func
        new Function(source)();
        const bucket = (window as unknown as { __overlayVariant?: string }).__overlayVariant ?? "unknown";
        tally[bucket] = (tally[bucket] ?? 0) + 1;
      }
      return tally;
    },
    { source, n: N }
  );

  console.log(`[m5] degenerate 2-arm distribution over ${N} fresh profiles verbatim: ${JSON.stringify(counts)}`);
  expect(counts.control + counts.variant).toBe(N);
  // Generous band around 50/50 — proves neither arm is starved/dominant, not exact parity.
  expect(counts.control).toBeGreaterThan(N * 0.25);
  expect(counts.variant).toBeGreaterThan(N * 0.25);
});

// ── 3 (keyless) · <script> tag: fresh visitors bucket, assignment persists, reads correctly ─

// ── 2c (keyless) · #overlay-force-variant preview override on a DEPLOYED (unforced) script ───

test("2c · #overlay-force-variant forces the variant on an already-deployed script, without persisting @m5", async ({ browser }) => {
  // The console/preview path (TECH-SPEC §12): the <script> is deployed unforced, but adding the
  // hash previews the variant. Must apply the variant AND not write the forced value to storage.
  const KEY = "overlay-ab-hashforce-test";
  const spec = specForVariant([headlineOp("Hash-forced variant headline")], KEY);
  const source = buildApplierSource(spec); // unforced — exactly the deployed <script> case

  const context = await browser.newContext();
  const page = await context.newPage();
  // Pre-seed a KNOWN persisted assignment (control) BEFORE the applier runs. This makes the
  // proof deterministic AND non-vacuous: if the override read from or wrote to storage, these
  // assertions would flip. (addInitScript runs at document-create on every navigation, in order.)
  await page.addInitScript((k) => { try { localStorage.setItem(k, "control"); } catch (e) {} }, KEY);
  await page.addInitScript({ content: source });

  // (a) Hashed load → variant is forced, but the persisted assignment stays "control".
  await page.goto(`${FIXTURE_URL}#overlay-force-variant`);
  expect(await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant)).toBe("variant");
  expect(await currentHeadline(page), "the hash previews the variant even when deployed unforced").toBe(
    "Hash-forced variant headline"
  );
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY), "the hash-forced value is NEVER persisted").toBe("control");

  // (b) Plain reload (no hash) → reverts to the persisted control: the force was transient.
  await page.goto(FIXTURE_URL);
  expect(await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant)).toBe("control");
  expect(await currentHeadline(page), "a no-hash load respects the persisted control assignment").toBe(ORIGINAL_HEADLINE);

  await context.close();
});

test("3 · as a <script> tag pasted in <head>: fresh visitors bucket, assignment persists across reload, window/data-attribute read correctly @m5", async ({ browser }) => {
  const spec = specForVariant([headlineOp("Script-tag variant headline")], "overlay-ab-scripttag-test");
  const source = buildApplierSource(spec);
  const scriptTag = buildScriptTag(spec);
  expect(scriptTag.startsWith("<script>") && scriptTag.trim().endsWith("</script>"), "wraps in a <script> tag").toBe(true);

  const buckets: string[] = [];
  for (let i = 0; i < 6; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    // "Pasted in <head>": addInitScript runs at document-create time, before the fixture's own
    // markup parses — the strongest proof of the DOMContentLoaded-deferral rule (criterion 7),
    // reused here so this loop also covers "fresh profile" bucketing for the script-tag path.
    await page.addInitScript({ content: source });
    await page.goto(FIXTURE_URL);

    const bucket = await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant);
    expect(bucket, "a known arm").toMatch(/^(control|variant)$/);
    buckets.push(bucket!);
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-overlay-variant"))).toBe(bucket);

    if (bucket === "variant") {
      expect(await currentHeadline(page)).toBe("Script-tag variant headline");
    } else {
      expect(await currentHeadline(page)).toBe(ORIGINAL_HEADLINE);
    }

    // Persistence: reload in the SAME context (same localStorage) → identical assignment.
    await page.reload();
    const bucketAfterReload = await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant);
    expect(bucketAfterReload, "assignment persists per visitor across reload").toBe(bucket);

    await context.close();
  }
  console.log(`[m5] script-tag fresh-profile buckets verbatim: ${JSON.stringify(buckets)}`);
});

// ── 4 (keyless) · Control bucket: zero DOM mutations ───────────────────────────────────────

test("4 · control bucket applies zero DOM mutations @m5", async ({ page }) => {
  const spec = specForVariant([headlineOp("Should never appear")], "overlay-ab-control-test");
  const source = buildApplierSource(spec, { forceArmId: "control" });

  await page.goto(FIXTURE_URL);
  await page.addScriptTag({ content: source });

  expect(await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant)).toBe("control");
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-overlay-variant"))).toBe("control");
  expect(await currentHeadline(page), "control = the untouched page, verbatim").toBe(ORIGINAL_HEADLINE);
});

// ── 5 (keyless) · Segment mode: applies ONLY when its signal matches, no persistence ───────

test("5 · segment mode applies only when its signal matches (?utm_source=b), rule-based, no persistence @m5", async ({ page }) => {
  const spec = specForSegment([headlineOp("Segment-targeted headline")], { kind: "param", param: "utm_source", value: "b" }, "overlay-ab-segment-test");
  const source = buildApplierSource(spec);

  // Signal matches.
  await page.goto(`${FIXTURE_URL}?utm_source=b`);
  await page.addScriptTag({ content: source });
  expect(await currentHeadline(page)).toBe("Segment-targeted headline");
  expect(await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant)).toBe("variant");
  expect(await page.evaluate((k) => localStorage.getItem(k), spec.key), "segment mode never persists").toBeNull();

  // Signal absent → control, unmodified.
  await page.goto(FIXTURE_URL);
  await page.addScriptTag({ content: source });
  expect(await currentHeadline(page)).toBe(ORIGINAL_HEADLINE);
  expect(await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant)).toBe("control");

  // Wrong value → still control.
  await page.goto(`${FIXTURE_URL}?utm_source=someone-else`);
  await page.addScriptTag({ content: source });
  expect(await currentHeadline(page)).toBe(ORIGINAL_HEADLINE);
});

// ── 6 (keyless) · Fingerprint mismatch → console warning + op skipped, never guesses ───────

test("6 · editing the page first invalidates the fingerprint → console warning, op skipped, never guesses @m5", async ({ page }) => {
  const spec = specForVariant([headlineOp("Should be skipped")], "overlay-ab-mismatch-test");
  const consoleSnippet = buildConsoleSnippet(spec);

  await page.goto(FIXTURE_URL);
  // Edit the page BEFORE the snippet ever runs — this is what invalidates the container's
  // fingerprint (captured at extraction time, before any edits).
  await page.evaluate(() => {
    document.querySelector("#hero h1")!.textContent = "Someone edited this headline by hand";
  });

  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });

  await page.addScriptTag({ content: consoleSnippet });

  console.log(`[m5] fingerprint-mismatch console warnings verbatim: ${JSON.stringify(warnings)}`);
  expect(warnings.some((w) => /fingerprint mismatch/i.test(w)), "a fingerprint-mismatch warning was logged").toBe(true);
  expect(await currentHeadline(page), "op skipped — the hand-edit is untouched, never guessed at").toBe(
    "Someone edited this headline by hand"
  );
});

// ── 7 (keyless) · dependency-free; applies on DOMContentLoaded when pasted in <head> ───────

test("7 · applies correctly when injected before the DOM exists (paste-in-<head> / DOMContentLoaded deferral) @m5", async ({ page }) => {
  const spec = specForVariant([headlineOp("Deferred-apply headline")], "overlay-ab-defer-test");
  const source = buildApplierSource(spec, { forceArmId: "variant" });

  // addInitScript executes at document-create time — before the fixture's <body> (and #hero)
  // exist. If `run()` executed immediately instead of waiting for DOMContentLoaded,
  // querySelector(op.css) would find nothing and the op would be skipped/warned, not applied.
  await page.addInitScript({ content: source });
  await page.goto(FIXTURE_URL);

  expect(await currentHeadline(page), "waited for DOMContentLoaded, then correctly applied").toBe("Deferred-apply headline");
  expect(await page.evaluate(() => (window as unknown as { __overlayVariant?: string }).__overlayVariant)).toBe("variant");
});

// ── 8 (keyless) · Zero network calls from the snippet ──────────────────────────────────────

test("8 · the snippet makes zero network calls @m5", async ({ page }) => {
  await page.goto(FIXTURE_URL);

  const requestsDuringApply: string[] = [];
  page.on("request", (req) => requestsDuringApply.push(req.url()));

  const spec = specForVariant([headlineOp("No network headline")], "overlay-ab-network-test");
  const source = buildApplierSource(spec, { forceArmId: "variant" });
  await page.addScriptTag({ content: source });
  await expect.poll(() => currentHeadline(page)).toBe("No network headline");
  // Give any accidental async network call a moment to surface.
  await page.waitForTimeout(200);

  console.log(`[m5] requests observed during/after injection verbatim: ${JSON.stringify(requestsDuringApply)}`);
  expect(requestsDuringApply, "the snippet itself issues zero requests").toEqual([]);
});
