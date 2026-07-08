// COM module e2e spec — @m6
// Tests: isolation (no agent/store imports — keyless @smoke), output shape, fixture sign
// ordering (@ai — skip cleanly when ANTHROPIC_API_KEY is absent, per CLAUDE.md harness rules).

import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Isolation check — COM must import nothing from agent.ts or stores.
// Static source check, no API needed → @smoke, always runs keyless.
// ---------------------------------------------------------------------------
test("COM module isolation — zero imports from agent.ts or stores @m6 @smoke", async () => {
  // Read com.ts and assert it doesn't import from agent or store modules
  const comSource = await readFile(join(process.cwd(), "lib/com.ts"), "utf-8");

  // Match actual import/require statements, not comments or string literals in comments.
  // Use line-by-line check to avoid false positives from doc comments.
  const lines = comSource.split("\n").filter((l) => !l.trimStart().startsWith("//"));
  const uncommented = lines.join("\n");

  const forbiddenImports = [
    /from\s+["'].*agent["']/,
    /from\s+["'].*store["']/,
    /^import\s+.*\bfrom\s+["'].*\bagent\b/m,
    /^import\s+.*\bfrom\s+["'].*\bstore\b/m,
    /require\s*\(\s*["'].*agent["']\s*\)/,
    /require\s*\(\s*["'].*store["']\s*\)/,
  ];

  for (const pattern of forbiddenImports) {
    expect(
      uncommented.match(pattern),
      `lib/com.ts must not import from agent or store — found: ${pattern}`
    ).toBeNull();
  }
});

// Guard: all remaining tests are @ai — must skip cleanly without ANTHROPIC_API_KEY
test.beforeEach(({ }, testInfo) => {
  if (!process.env.ANTHROPIC_API_KEY && !testInfo.title.includes("@smoke")) {
    testInfo.skip();
  }
});

// ---------------------------------------------------------------------------
// Output shape — scoreVariant returns a valid ComScore
// ---------------------------------------------------------------------------
test("scoreVariant returns valid ComScore shape @m6 @ai", async () => {
  // Dynamic import after key guard
  const { scoreVariant } = await import("../lib/com");

  const score = await scoreVariant({
    brief: null,
    goal: "increase signups",
    control: [{ path: "hero.headline", slots: { headline: "Sign up" } }],
    variant: [{ path: "hero.headline", slots: { headline: "Join 10,000 engineers shipping faster — free" } }],
  });

  // Shape checks
  expect(typeof score.control).toBe("number");
  expect(typeof score.variant).toBe("number");
  expect(typeof score.delta).toBe("number");
  expect(typeof score.confidence).toBe("number");
  expect(Array.isArray(score.reasons)).toBe(true);

  // Range checks
  expect(score.control).toBeGreaterThanOrEqual(0);
  expect(score.control).toBeLessThanOrEqual(1);
  expect(score.variant).toBeGreaterThanOrEqual(0);
  expect(score.variant).toBeLessThanOrEqual(1);
  expect(score.confidence).toBeGreaterThanOrEqual(0);
  expect(score.confidence).toBeLessThanOrEqual(1);
  expect(score.reasons.length).toBeLessThanOrEqual(4);

  // Delta consistency
  expect(score.delta).toBeCloseTo(score.variant - score.control, 5);
});

// ---------------------------------------------------------------------------
// Obviously-better fixture — delta must be positive
// ---------------------------------------------------------------------------
test("obviously-better fixture scores positive delta @m6 @ai", async () => {
  const { scoreVariant } = await import("../lib/com");
  const fixture = JSON.parse(
    await readFile(join(process.cwd(), "fixtures/com/01-obviously-better.json"), "utf-8")
  );

  const score = await scoreVariant(fixture.input);
  expect(score.delta).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Obviously-worse fixture — delta must be negative
// ---------------------------------------------------------------------------
test("obviously-worse fixture scores negative delta @m6 @ai", async () => {
  const { scoreVariant } = await import("../lib/com");
  const fixture = JSON.parse(
    await readFile(join(process.cwd(), "fixtures/com/02-obviously-worse.json"), "utf-8")
  );

  const score = await scoreVariant(fixture.input);
  expect(score.delta).toBeLessThan(0);
});

// ---------------------------------------------------------------------------
// Identical fixture — |delta| ≤ 0.05
// ---------------------------------------------------------------------------
test("identical fixture delta is near-zero @m6 @ai", async () => {
  const { scoreVariant } = await import("../lib/com");
  const fixture = JSON.parse(
    await readFile(join(process.cwd(), "fixtures/com/03-identical.json"), "utf-8")
  );

  const score = await scoreVariant(fixture.input);
  const threshold = fixture.maxAbsDelta ?? 0.05;
  expect(Math.abs(score.delta)).toBeLessThanOrEqual(threshold);
});

// ---------------------------------------------------------------------------
// Null-brief fixture — COM handles null brief gracefully
// ---------------------------------------------------------------------------
test("null-brief fixture runs without error @m6 @ai", async () => {
  const { scoreVariant } = await import("../lib/com");
  const fixture = JSON.parse(
    await readFile(join(process.cwd(), "fixtures/com/06-null-brief.json"), "utf-8")
  );

  // Should not throw, should return valid shape
  const score = await scoreVariant(fixture.input);
  expect(typeof score.delta).toBe("number");
  expect(score.reasons.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Reasons reference brief ICP/objections — not generic copy taste
// ---------------------------------------------------------------------------
test("reasons reference ICP/objections/proof language @m6 @ai", async () => {
  const { scoreVariant } = await import("../lib/com");
  const fixture = JSON.parse(
    await readFile(join(process.cwd(), "fixtures/com/05-objection-handled.json"), "utf-8")
  );

  const score = await scoreVariant(fixture.input);

  // At least one reason must reference fixture 05's brief-specific language — the
  // unhandled objection (self-hosting ops burden / setup-sprint fear) or the ICP —
  // not generic copy-taste tokens. Deliberately excludes near-generic words
  // (control, goal, specific, signup) that any rating could emit.
  const reasons = score.reasons.join(" ").toLowerCase();
  const hasBriefSpecificLanguage =
    reasons.includes("objection") ||
    reasons.includes("self-host") ||
    reasons.includes("self host") ||
    reasons.includes("selfhost") ||
    reasons.includes("devops") ||
    reasons.includes("ops burden") ||
    reasons.includes("sprint") ||
    reasons.includes("5 minutes") ||
    reasons.includes("five minutes") ||
    reasons.includes("one command") ||
    reasons.includes("managed") ||
    reasons.includes("engineer");

  expect(hasBriefSpecificLanguage).toBe(true);
  expect(score.reasons.length).toBeGreaterThan(0);
});
