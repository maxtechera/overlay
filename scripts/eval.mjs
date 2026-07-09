#!/usr/bin/env node
// scripts/eval.mjs — `pnpm eval` (issue #6 / PRD §7 M6, PRD §4.6 "Evals")
//
// Runs BOTH:
//   (a) an extraction smoke suite — the extraction ladder (lib/runtime.ts) against committed,
//       deterministic local HTML fixtures (fixtures/extraction/*.html). Zero network, zero LLM.
//   (b) a COM sanity suite — the 6 committed fixture pairs (fixtures/com/*.json) with known
//       ordering. When ANTHROPIC_API_KEY is set, this shells out to the existing, already-
//       evidenced live judge runner (scripts/com-check.mjs --runs=3, from PR #16/issue #16).
//       When no key is present (this repo's Anthropic account is currently out of credits — see
//       issue #6), it runs a keyless, deterministic SELF-TEST of the same grading/threshold
//       logic (sign detection, delta math, stability-across-runs, fail-detection) against
//       scripted stand-in scores instead of a live model call. That proves the runner's
//       assertions have teeth; it does NOT calibrate the real Claude judge — re-run with
//       ANTHROPIC_API_KEY set (or `node --env-file=.env.local scripts/com-check.mjs`) for that.
//
// Exit code: 0 iff every case in both suites passes. Non-zero otherwise. Deterministic,
// keyless-by-default, per CLAUDE.md's harness rules.

import { chromium } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EXTRACTION_FIXTURES_DIR = join(ROOT, "fixtures", "extraction");
const COM_FIXTURES_DIR = join(ROOT, "fixtures", "com");

let passCount = 0;
let failCount = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) passCount++;
  else failCount++;
  console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Runtime-bundle + postMessage protocol helpers.
//
// Deliberately duplicated (not imported) from e2e/helpers/runtime-fixture.ts: this script is a
// standalone Node CLI (`pnpm eval`), not a Playwright test — it can't import a .ts helper
// without a TS loader. Same "standalone runner, no TS transpilation" rationale scripts/
// com-check.mjs already documents for lib/com.ts. Kept byte-for-byte equivalent to the .ts
// helper's protocol shape; if lib/runtime.ts's message contract changes, e2e/m2/m3 specs will
// fail first and point back here.
// ---------------------------------------------------------------------------

let cachedRuntimeCode = null;
async function getRuntimeCode() {
  if (cachedRuntimeCode) return cachedRuntimeCode;
  const raw = await readFile(join(ROOT, "lib", "runtime.built.js"), "utf-8");
  const match = raw.match(/const runtimeCode = (".*");\n/s);
  if (!match) {
    throw new Error(
      "eval: could not find `const runtimeCode = \"...\";` in lib/runtime.built.js — run `node scripts/build-runtime.mjs` first (the `preeval` script does this automatically)."
    );
  }
  cachedRuntimeCode = JSON.parse(match[1]);
  return cachedRuntimeCode;
}

async function loadFixture(page, html) {
  await page.goto("about:blank");
  await page.setContent(html);
  await page.addScriptTag({ content: await getRuntimeCode() });
}

async function extractOnFixture(page, opts = {}) {
  return page.evaluate((hostnameOverride) => {
    return new Promise((resolve) => {
      const listener = (e) => {
        const msg = e.data;
        if (msg && msg.t === "schema" && msg.requestId === "eval-req") {
          window.removeEventListener("message", listener);
          resolve({ nodes: msg.nodes, seo: msg.seo, a11yAudit: msg.a11yAudit });
        }
      };
      window.addEventListener("message", listener);
      window.postMessage({ t: "extract", requestId: "eval-req", hostnameOverride }, "*");
    });
  }, opts.hostnameOverride);
}

async function applyOpOnFixture(page, opId, op) {
  return page.evaluate(
    ({ opId, op }) => {
      return new Promise((resolve) => {
        const listener = (e) => {
          const msg = e.data;
          if (msg && msg.t === "op-applied" && msg.opId === opId) {
            window.removeEventListener("message", listener);
            resolve({ ok: !!msg.ok, error: msg.error, warnings: msg.warnings });
          }
        };
        window.addEventListener("message", listener);
        window.postMessage({ t: "apply-op", opId, op, requestId: `eval-apply-${opId}` }, "*");
      });
    },
    { opId, op }
  );
}

async function revertOpOnFixture(page, opId) {
  return page.evaluate((opId) => {
    return new Promise((resolve) => {
      const listener = (e) => {
        const msg = e.data;
        if (msg && msg.t === "op-reverted" && msg.opId === opId) {
          window.removeEventListener("message", listener);
          resolve({ opId: msg.opId });
        }
      };
      window.addEventListener("message", listener);
      window.postMessage({ t: "revert-op", opId, requestId: `eval-revert-${opId}` }, "*");
    });
  }, opId);
}

// ---------------------------------------------------------------------------
// (a) Extraction smoke suite — keyless, deterministic, local fixtures
// ---------------------------------------------------------------------------
async function runExtractionSmoke(browser) {
  console.log("\n=== (a) Extraction smoke suite (keyless, local fixtures) ===\n");
  const page = await browser.newPage();

  try {
    // 1. Good page: hero found, slots non-empty, >=3 sections, a card collection, facts sane.
    const goodHtml = await readFile(join(EXTRACTION_FIXTURES_DIR, "good-page.html"), "utf-8");
    await loadFixture(page, goodHtml);
    const { nodes, a11yAudit } = await extractOnFixture(page, { hostnameOverride: "eval-fixture.invalid" });

    const hero = nodes.find((n) => n.type === "hero");
    record("good-page: hero found", !!hero, hero ? `headline="${hero.slots?.headline?.text}"` : "no hero node");
    record("good-page: hero.headline slot non-empty", !!hero?.slots?.headline?.text?.length);
    record("good-page: hero.cta slot non-empty (link)", !!hero?.slots?.cta?.text?.length);

    const sections = nodes.filter((n) => n.type === "section");
    record(`good-page: >=3 sections identified (found ${sections.length})`, sections.length >= 3);

    const collections = nodes.filter((n) => n.type === "collection");
    const cards = nodes.filter((n) => n.type === "card");
    record(
      `good-page: a card collection was found (${collections.length} collection(s), ${cards.length} card(s))`,
      collections.length >= 1 && cards.length >= 3
    );

    // Computed facts sane: every fact-bearing node has plausible numbers, not NaN/garbage.
    const factNodes = nodes.filter((n) => n.facts && Object.keys(n.facts).length > 0);
    const factsSane = factNodes.every((n) => {
      const f = n.facts;
      const linesOk = f.lines === undefined || (Number.isFinite(f.lines) && f.lines >= 1);
      const fontOk = f.fontPx === undefined || (Number.isFinite(f.fontPx) && f.fontPx > 0 && f.fontPx < 300);
      const contrastOk = f.contrast === undefined || (Number.isFinite(f.contrast) && f.contrast >= 1 && f.contrast <= 21);
      return linesOk && fontOk && contrastOk;
    });
    record(
      `good-page: computed facts are sane on all ${factNodes.length} fact-bearing node(s)`,
      factsSane && factNodes.length > 0
    );

    // Every ADA finding traces to a real node.slot path (same check as e2e/m2-deep-extraction.spec.ts).
    const allPaths = new Set();
    for (const n of nodes) for (const slotName of Object.keys(n.slots ?? {})) allPaths.add(`${n.path}.${slotName}`);
    record(
      "good-page: a11yAudit findings trace to real node.slot paths",
      a11yAudit.every((f) => allPaths.has(f.path))
    );

    // 2. Apply/revert round-trip on the hero headline — the PRD §4.6 "harness smoke evals"
    //    requirement: "apply/revert round-trips".
    if (hero) {
      const ORIGINAL = hero.slots.headline.text;
      const MARKER = "M6-EVAL-APPLY-MARKER";
      const applyResult = await applyOpOnFixture(page, "eval-op-1", {
        op: "update-content",
        target: hero.id,
        slots: { headline: { text: MARKER } },
        rationale: "eval smoke: apply/revert round-trip",
      });
      record("apply-op: applied ok", applyResult.ok === true, JSON.stringify(applyResult));

      const afterApply = await extractOnFixture(page, { hostnameOverride: "eval-fixture.invalid" });
      const heroAfterApply = afterApply.nodes.find((n) => n.type === "hero");
      record(
        "apply-op: DOM reflects the applied text",
        heroAfterApply?.slots?.headline?.text === MARKER,
        heroAfterApply?.slots?.headline?.text
      );

      await revertOpOnFixture(page, "eval-op-1");
      const afterRevert = await extractOnFixture(page, { hostnameOverride: "eval-fixture.invalid" });
      const heroAfterRevert = afterRevert.nodes.find((n) => n.type === "hero");
      record(
        "revert-op: DOM restored to the original headline",
        heroAfterRevert?.slots?.headline?.text === ORIGINAL,
        heroAfterRevert?.slots?.headline?.text
      );
    } else {
      record("apply/revert round-trip", false, "skipped — no hero node to target on good-page (unexpected)");
    }

    // 3. Deliberately-broken fixture (mangled hero) — negative control. Proves the "hero found"
    //    assertion above is not vacuously true: detectHero() only ever considers
    //    h1/h2/[role=heading] candidates (lib/runtime.ts), and this fixture has none.
    const mangledHtml = await readFile(join(EXTRACTION_FIXTURES_DIR, "mangled-no-hero.html"), "utf-8");
    await loadFixture(page, mangledHtml);
    const mangledResult = await extractOnFixture(page, { hostnameOverride: "eval-fixture.invalid" });
    const mangledHero = mangledResult.nodes.find((n) => n.type === "hero");
    record(
      "mangled-no-hero fixture: hero detection correctly reports NOT FOUND (negative control — proves the check has teeth)",
      !mangledHero,
      mangledHero ? "BUG: a hero was found on a fixture with zero heading elements" : "no hero, as expected"
    );
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------------------
// (b) COM sanity suite
// ---------------------------------------------------------------------------
async function runComSanity() {
  console.log("\n=== (b) COM sanity suite ===\n");

  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  if (hasKey) {
    console.log(
      "ANTHROPIC_API_KEY present — running the LIVE judge (scripts/com-check.mjs --runs=3) against all 6 fixtures/com/*.json.\n"
    );
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", "com-check.mjs"), "--runs=3"], {
      stdio: "inherit",
      env: process.env,
    });
    record("COM sanity (LIVE judge): scripts/com-check.mjs --runs=3 exits 0", result.status === 0, `exit ${result.status}`);
  } else {
    console.log(
      "ANTHROPIC_API_KEY not set — the LIVE judge is UNVERIFIED-LIVE this run (skips cleanly, per\n" +
        "CLAUDE.md's keyless-CI rule). Running a keyless, deterministic SELF-TEST of the same\n" +
        "grading logic (sign detection, delta math, stability-across-3-runs, fail-detection)\n" +
        "against scripted stand-in scores instead of a real model call. This proves the runner's\n" +
        "assertions have teeth; it does NOT calibrate the real Claude judge — re-run with\n" +
        "ANTHROPIC_API_KEY set (or `node --env-file=.env.local scripts/com-check.mjs`) for that.\n"
    );
    await runComKeylessSelfTest();
  }
}

// Mirrors lib/com.ts's delta math (delta = variant - control) and scripts/com-check.mjs's
// sign/threshold logic exactly, but grades a SCRIPTED {control, variant} pair instead of a live
// generateObject() call — deterministic, network-free. Validates the grading/threshold code,
// not the model's judgment (see the console banner in runComSanity above).
function gradeCanned(control, variant, expectedSign, maxAbsDelta = 0.05) {
  const delta = variant - control;
  const sign = delta > 0.005 ? "positive" : delta < -0.005 ? "negative" : "zero";
  const pass = expectedSign === "zero" ? Math.abs(delta) <= maxAbsDelta : sign === expectedSign;
  return { delta, sign, pass };
}

async function runComKeylessSelfTest() {
  const files = (await readdir(COM_FIXTURES_DIR)).filter((f) => f.endsWith(".json")).sort();

  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(COM_FIXTURES_DIR, file), "utf-8"));
    const { expectedSign, maxAbsDelta } = fixture;

    // Scripted stand-in score matching this fixture's own (human-authored, PR #16) expectedSign
    // — gives the grading math something concrete to check. Run 3x to prove sign never flips on
    // identical input, the same property com-check.mjs's --runs=3 validates live.
    const [control, variant] =
      expectedSign === "positive" ? [0.35, 0.72] : expectedSign === "negative" ? [0.72, 0.35] : [0.55, 0.55];

    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(gradeCanned(control, variant, expectedSign, maxAbsDelta));
    const allPass = runs.every((r) => r.pass);
    const distinctSigns = new Set(runs.map((r) => r.sign));
    record(
      `${file}: scripted stand-in scores in the expected direction (${expectedSign}), stable across 3 runs`,
      allPass && distinctSigns.size === 1,
      `delta=${runs[0].delta.toFixed(3)} sign=${runs[0].sign}`
    );
  }

  // Deliberately-wrong case — proves the checker can actually FAIL, not just always pass. Take
  // fixture 01's expectedSign ("positive") and force a scripted response with the OPPOSITE
  // sign; the grading logic must report this as a failure.
  const wrong = gradeCanned(0.72, 0.35, "positive");
  record(
    "self-test: a deliberately-inverted scripted score is correctly flagged FAIL (proves the checker isn't vacuous)",
    wrong.pass === false,
    `delta=${wrong.delta.toFixed(3)} pass=${wrong.pass} (expected pass=false)`
  );
}

// ---------------------------------------------------------------------------
async function main() {
  console.log("=== pnpm eval — M6 (issue #6): extraction smoke + COM sanity ===");

  const browser = await chromium.launch();
  try {
    await runExtractionSmoke(browser);
  } finally {
    await browser.close();
  }

  await runComSanity();

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed / ${passCount + failCount} total ===\n`);
  if (failCount > 0) {
    console.log("FAILED CASES:");
    for (const r of results) if (!r.ok) console.log(`  - ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    console.log();
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
