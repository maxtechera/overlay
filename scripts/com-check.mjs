#!/usr/bin/env node
// COM sanity fixture runner — pnpm com:check
// Runs all fixtures/com/*.json against scoreVariant, prints per-case report.
// Usage: node --env-file=.env.local scripts/com-check.mjs
// Stability check: pass --runs=3 to run each fixture 3 times and verify sign never flips.

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "../fixtures/com");

// Inline COM_SYSTEM (same as lib/com.ts — runner is standalone, no TS transpilation needed)
const COM_SYSTEM = `You are an independent conversion-rating model. Input: a page's conversion brief (may be null), a goal, and before/after content for the changed components. Rate control and variant separately (0–1) for how likely each is to achieve the goal for this audience. Judge only what you see; do not assume the variant is better because it is newer. Reasons: concrete, ≤4, terse.`;

const comScoreSchema = z.object({
  control: z.number().min(0).max(1),
  variant: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(4),
});

async function scoreVariant(input, anthropic) {
  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: comScoreSchema,
    system: COM_SYSTEM,
    prompt: JSON.stringify(input),
  });
  return { ...object, delta: object.variant - object.control };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — set it in .env.local and use node --env-file=.env.local");
    process.exit(1);
  }

  const anthropic = createAnthropic({ apiKey });

  const args = process.argv.slice(2);
  const runsArg = args.find((a) => a.startsWith("--runs="));
  const RUNS = runsArg ? parseInt(runsArg.replace("--runs=", ""), 10) : 1;

  const files = (await readdir(FIXTURES_DIR))
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`\n=== COM sanity suite — ${files.length} fixtures, ${RUNS} run(s) each ===\n`);

  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const raw = await readFile(join(FIXTURES_DIR, file), "utf-8");
    const fixture = JSON.parse(raw);
    const { description, expectedSign, maxAbsDelta, input } = fixture;

    console.log(`--- ${file}`);
    console.log(`    ${description}`);

    const scores = [];
    const signs = [];

    for (let run = 1; run <= RUNS; run++) {
      try {
        const score = await scoreVariant(input, anthropic);
        scores.push(score);
        const sign = score.delta > 0.005 ? "positive" : score.delta < -0.005 ? "negative" : "zero";
        signs.push(sign);

        console.log(
          `    run ${run}: control=${score.control.toFixed(3)} variant=${score.variant.toFixed(3)} ` +
            `delta=${score.delta >= 0 ? "+" : ""}${score.delta.toFixed(3)} conf=${score.confidence.toFixed(2)} sign=${sign}`
        );
        console.log(`    reasons: ${score.reasons.join(" | ")}`);
      } catch (err) {
        console.error(`    run ${run}: ERROR — ${err.message}`);
        failed++;
        continue;
      }
    }

    if (scores.length === 0) continue;

    // Validate expected sign
    let casePassed = true;

    if (expectedSign === "zero") {
      const threshold = maxAbsDelta ?? 0.05;
      const allZero = scores.every((s) => Math.abs(s.delta) <= threshold);
      if (!allZero) {
        const worst = Math.max(...scores.map((s) => Math.abs(s.delta)));
        console.log(`    FAIL: expected |delta| ≤ ${threshold} (got ${worst.toFixed(3)})`);
        casePassed = false;
      } else {
        console.log(`    PASS: identical fixture — |delta| ≤ ${threshold} ✓`);
      }
    } else {
      // Check sign consistency across runs
      const uniqueSigns = [...new Set(signs)];
      const signFlipped = uniqueSigns.length > 1 && !(uniqueSigns.every((s) => s === "zero"));
      if (signFlipped) {
        console.log(`    FAIL: sign flipped across runs — ${signs.join(", ")}`);
        casePassed = false;
      }

      // Check expected sign
      const dominantSign = signs.filter((s) => s !== "zero").length > signs.length / 2
        ? signs.filter((s) => s !== "zero")[0]
        : "zero";

      if (dominantSign !== expectedSign) {
        console.log(`    FAIL: expected ${expectedSign}, got ${dominantSign}`);
        casePassed = false;
      } else {
        console.log(`    PASS: sign=${dominantSign} (expected ${expectedSign}) ✓`);
      }
    }

    if (casePassed) {
      passed++;
    } else {
      failed++;
    }

    // Log calibration output (score + verdict joinable for future training)
    const lastScore = scores[scores.length - 1];
    const verdict = expectedSign === "zero"
      ? (Math.abs(lastScore.delta) <= (maxAbsDelta ?? 0.05) ? "correct" : "incorrect")
      : (signs[signs.length - 1] === expectedSign ? "correct" : "incorrect");

    console.log(
      `    calibration: { fixture: "${file}", goal: "${input.goal}", ` +
        `delta: ${lastScore.delta.toFixed(3)}, expected: "${expectedSign}", verdict: "${verdict}" }`
    );
    console.log();
  }

  console.log(`=== Results: ${passed} passed, ${failed} failed / ${files.length} total ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
