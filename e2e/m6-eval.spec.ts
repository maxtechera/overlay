/**
 * e2e/m6-eval.spec.ts — M6 acceptance checklist (issue #6): `pnpm eval` = extraction smoke suite
 * + COM sanity suite, reported pass/fail, exit-coded. All @m6, all keyless/deterministic.
 *
 * Two layers of evidence:
 *  1. Black-box: run the REAL CLI (`node scripts/eval.mjs`) as CI will, and assert its readable
 *     summary + exit code — proves `pnpm eval` itself works, not just the logic behind it.
 *  2. White-box: drive the SAME committed fixtures/extraction/*.html through the canonical
 *     runtime-fixture helpers (reused from e2e/m2-deep-extraction.spec.ts's own import, not
 *     duplicated) to prove the extraction assertions hold against the production bundle
 *     directly — including the deliberately-mangled negative-control fixture (issue #6:
 *     "a deliberately broken fixture (mangled hero) FAILS the suite — the suite can actually
 *     fail") and an apply/revert round-trip (PRD §4.6 "harness smoke evals").
 */

import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadFixture, extractOnFixture, applyOpOnFixture, revertOpOnFixture } from "./helpers/runtime-fixture";

const execFileAsync = promisify(execFile);

// ── 1 · black-box: the real `pnpm eval` CLI, exit-coded with a readable per-case report ──

test("pnpm eval — extraction smoke + COM sanity run clean, exit 0, readable per-case report @m6", async () => {
  const { stdout } = await execFileAsync("node", ["scripts/eval.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 60_000,
  });

  // Readable per-case report: every recorded case prints PASS/FAIL plus a name.
  expect(stdout).toMatch(/PASS — good-page: hero found/);
  expect(stdout).toMatch(/PASS — mangled-no-hero fixture: hero detection correctly reports NOT FOUND/);
  expect(stdout).toMatch(/PASS — apply-op: applied ok/);
  expect(stdout).toMatch(/PASS — revert-op: DOM restored to the original headline/);

  // COM sanity: known-ordering fixtures score in the expected direction.
  expect(stdout).toMatch(/01-obviously-better\.json.*positive/);
  expect(stdout).toMatch(/02-obviously-worse\.json.*negative/);
  expect(stdout).toMatch(/03-identical\.json.*zero/);

  // The suite can actually fail: swapping control/variant on a non-zero fixture flips the sign,
  // proving the deterministic core (not a rubber-stamped stand-in) drives the verdict. Issue #45
  // replaced the old scripted self-test with this mutation-worthy proof against the REAL scorer.
  expect(stdout).toMatch(/mutation-worthy: swapping control\/variant on 01-obviously-better flips the sign/);

  // Clean pass/fail summary, 0 failures on a healthy tree.
  expect(stdout).toMatch(/=== Results: \d+ passed, 0 failed \/ \d+ total ===/);
  // (execFileAsync would itself throw on a non-zero exit code — reaching here already proves
  // exit 0; the assertion above is the readable-report half of the acceptance item.)
});

// ── 2 · white-box: the extraction ladder against the committed fixtures, via the canonical
//        runtime-fixture helper (reused, not duplicated) ──

test("extraction smoke: good-page fixture — hero + >=3 sections + a card collection, facts sane @m6", async ({
  page,
}) => {
  const html = await readFile(join(process.cwd(), "fixtures/extraction/good-page.html"), "utf-8");
  await loadFixture(page, html);
  const { nodes } = await extractOnFixture(page, { hostnameOverride: "m6-eval-fixture.invalid" });

  const typed = nodes as unknown as Array<{
    id: string;
    path: string;
    type: string;
    slots: Record<string, { text?: string }>;
    facts?: { lines?: number; fontPx?: number; contrast?: number };
  }>;

  const hero = typed.find((n) => n.type === "hero");
  expect(hero, "hero node found").toBeTruthy();
  expect(hero!.slots.headline?.text?.length ?? 0).toBeGreaterThan(0);
  expect(hero!.slots.cta?.text?.length ?? 0).toBeGreaterThan(0);

  const sections = typed.filter((n) => n.type === "section");
  expect(sections.length, "at least 3 sections identified").toBeGreaterThanOrEqual(3);

  const collections = typed.filter((n) => n.type === "collection");
  const cards = typed.filter((n) => n.type === "card");
  expect(collections.length, "a card collection was found").toBeGreaterThanOrEqual(1);
  expect(cards.length, "cards where they exist").toBeGreaterThanOrEqual(3);

  // Computed facts sane — not NaN/garbage.
  const factNodes = typed.filter((n) => n.facts && Object.keys(n.facts).length > 0);
  expect(factNodes.length).toBeGreaterThan(0);
  for (const n of factNodes) {
    if (n.facts?.lines !== undefined) expect(n.facts.lines).toBeGreaterThanOrEqual(1);
    if (n.facts?.fontPx !== undefined) expect(n.facts.fontPx).toBeGreaterThan(0);
    if (n.facts?.contrast !== undefined) {
      expect(n.facts.contrast).toBeGreaterThanOrEqual(1);
      expect(n.facts.contrast).toBeLessThanOrEqual(21);
    }
  }
});

test("extraction smoke: apply-op / revert-op round-trip on the hero headline @m6", async ({ page }) => {
  const html = await readFile(join(process.cwd(), "fixtures/extraction/good-page.html"), "utf-8");
  await loadFixture(page, html);
  const { nodes } = await extractOnFixture(page, { hostnameOverride: "m6-eval-fixture.invalid" });
  const typed = nodes as unknown as Array<{ id: string; type: string; slots: Record<string, { text?: string }> }>;
  const hero = typed.find((n) => n.type === "hero");
  expect(hero).toBeTruthy();
  const original = hero!.slots.headline!.text!;

  const applyResult = await applyOpOnFixture(page, "m6-op-1", {
    op: "update-content",
    target: hero!.id,
    slots: { headline: { text: "M6-ROUNDTRIP-MARKER" } },
    rationale: "m6 eval spec: apply/revert round-trip",
  });
  expect(applyResult.ok).toBe(true);

  const afterApply = await extractOnFixture(page, { hostnameOverride: "m6-eval-fixture.invalid" });
  const heroAfterApply = (afterApply.nodes as unknown as Array<{ type: string; slots: Record<string, { text?: string }> }>).find(
    (n) => n.type === "hero"
  );
  expect(heroAfterApply?.slots.headline?.text).toBe("M6-ROUNDTRIP-MARKER");

  await revertOpOnFixture(page, "m6-op-1");
  const afterRevert = await extractOnFixture(page, { hostnameOverride: "m6-eval-fixture.invalid" });
  const heroAfterRevert = (afterRevert.nodes as unknown as Array<{ type: string; slots: Record<string, { text?: string }> }>).find(
    (n) => n.type === "hero"
  );
  expect(heroAfterRevert?.slots.headline?.text).toBe(original);
});

test("extraction smoke: mangled-no-hero fixture — hero detection correctly reports NOT FOUND (negative control) @m6", async ({
  page,
}) => {
  const html = await readFile(join(process.cwd(), "fixtures/extraction/mangled-no-hero.html"), "utf-8");
  await loadFixture(page, html);
  const { nodes } = await extractOnFixture(page, { hostnameOverride: "m6-eval-fixture.invalid" });
  const typed = nodes as unknown as Array<{ type: string }>;
  const hero = typed.find((n) => n.type === "hero");
  expect(hero, "hero must be absent — this fixture has zero h1/h2/[role=heading] elements").toBeFalsy();
});
