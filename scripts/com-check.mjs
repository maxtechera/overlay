#!/usr/bin/env node
// COM sanity fixture runner — pnpm com:check
// Runs all fixtures/com/*.json against the REAL lib/com.ts scorer, prints a per-case report.
//
// Issue #45 (deterministic COM core): the DETERMINISTIC path (computeDeterministicScore) is now
// the primary, always-run, keyless check — it needs no ANTHROPIC_API_KEY and exercises the actual
// heuristic in lib/com.ts (via scripts/com-load.mjs's esbuild bundle-and-import, not a duplicated
// copy), so a mutation to the real scoring math is caught here.
//
// When ANTHROPIC_API_KEY IS set, this additionally runs the LIVE judge (the optional LLM
// refinement layer — scoreVariant() blends it in when a key is present) for calibration and
// comparison; its sign/stability is folded into the overall pass/fail alongside the deterministic
// result, same as the original runner did.
//
// Usage:
//   node scripts/com-check.mjs                                (deterministic only, keyless)
//   node --env-file=.env.local scripts/com-check.mjs           (deterministic + live judge)
//   node --env-file=.env.local scripts/com-check.mjs --runs=3  (repeat the live judge N times)

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCom } from "./com-load.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "../fixtures/com");

function signOf(delta) {
  return delta > 0.005 ? "positive" : delta < -0.005 ? "negative" : "zero";
}

function checkExpectation(delta, expectedSign, maxAbsDelta) {
  if (expectedSign === "zero") return Math.abs(delta) <= (maxAbsDelta ?? 0.05);
  return signOf(delta) === expectedSign;
}

async function main() {
  const { computeDeterministicScore, scoreVariant } = await loadCom();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const args = process.argv.slice(2);
  const runsArg = args.find((a) => a.startsWith("--runs="));
  const RUNS = runsArg ? parseInt(runsArg.replace("--runs=", ""), 10) : 1;

  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".json")).sort();

  console.log(`\n=== COM sanity suite — ${files.length} fixtures ===`);
  console.log(
    apiKey
      ? "ANTHROPIC_API_KEY present — deterministic core (always) + live-judge blend (calibration).\n"
      : "ANTHROPIC_API_KEY not set — deterministic core only (keyless default, issue #45).\n"
  );

  let passed = 0;
  let failed = 0;

  for (const file of files) {
    const raw = await readFile(join(FIXTURES_DIR, file), "utf-8");
    const fixture = JSON.parse(raw);
    const { description, expectedSign, maxAbsDelta, input } = fixture;

    console.log(`--- ${file}`);
    console.log(`    ${description}`);

    // Deterministic path — pure, synchronous, no network. Run once; being a pure function of
    // fixed input, its stability across repeated calls is a byte-for-byte given (unlike the
    // model judge which the --runs flag exists to stability-check).
    const det = computeDeterministicScore(input);
    const detSign = signOf(det.delta);
    const detOk = checkExpectation(det.delta, expectedSign, maxAbsDelta);
    console.log(
      `    deterministic: control=${det.control.toFixed(3)} variant=${det.variant.toFixed(3)} ` +
        `delta=${det.delta >= 0 ? "+" : ""}${det.delta.toFixed(3)} conf=${det.confidence.toFixed(2)} sign=${detSign} ` +
        `${detOk ? "PASS" : "FAIL"} (expected ${expectedSign})`
    );
    console.log(`    reasons: ${det.reasons.join(" | ")}`);

    let casePassed = detOk;

    if (apiKey) {
      // Live judge (optional refinement layer) — run RUNS times, checking sign stability like
      // the original runner did.
      const signs = [];
      let lastScore = null;
      for (let run = 1; run <= RUNS; run++) {
        try {
          const score = await scoreVariant(input);
          lastScore = score;
          const sign = signOf(score.delta);
          signs.push(sign);
          console.log(
            `    live run ${run}: control=${score.control.toFixed(3)} variant=${score.variant.toFixed(3)} ` +
              `delta=${score.delta >= 0 ? "+" : ""}${score.delta.toFixed(3)} conf=${score.confidence.toFixed(2)} sign=${sign}`
          );
          console.log(`    live reasons: ${score.reasons.join(" | ")}`);
        } catch (err) {
          console.error(`    live run ${run}: ERROR — ${err.message}`);
        }
      }
      if (lastScore) {
        const liveOk = checkExpectation(lastScore.delta, expectedSign, maxAbsDelta);
        const stable = new Set(signs).size <= 1 || new Set(signs.filter((s) => s !== "zero")).size <= 1;
        console.log(`    live judge: ${liveOk && stable ? "PASS" : "FAIL"} (stable=${stable})`);
        casePassed = casePassed && liveOk && stable;
      }
    }

    if (casePassed) passed++;
    else failed++;
    console.log();
  }

  console.log(`=== Results: ${passed} passed, ${failed} failed / ${files.length} total ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
