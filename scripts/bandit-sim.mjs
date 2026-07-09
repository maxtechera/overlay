#!/usr/bin/env node
// scripts/bandit-sim.mjs — `pnpm sim` (issue #9 / PRD §4.8, §7 M9)
//
// Runnable Thompson-sampling bandit sim over SYNTHETIC traffic. All math lives in
// lib/bandit.ts (pure, unit-testable functions) — this script is a thin CLI: bundle that one
// TS module with esbuild (already a devDependency; same in-memory-bundle pattern as
// scripts/build-runtime.mjs) so a plain `node` process can run it with zero new dependencies
// and zero duplicated logic, then run three scenarios and print a readable report:
//
//   1. Convergence — does Thompson sampling find the best-true-rate arm, does regret decrease?
//   2. COM-prior vs uniform-prior — averaged over many seeds, does a COM-informed prior reach
//      the best arm in fewer pulls / lower cumulative regret than a flat prior? (the M9 point:
//      the COM prior is a useful head start, not decoration)
//   3. Wrong-prior recovery — if the COM prior is deliberately WRONG (favors a worse arm),
//      does enough synthetic traffic still override it and land on the true best arm? (PRD
//      §4.4/§7 M9: "honest framing" — it's a prior, not a verdict; real traffic wins)
//
// Deterministic: every run below uses a fixed seed (or fixed seed list). Exit 0 iff every
// assertion passes; exit 1 (with a printed reason) otherwise. Labeled synthetic everywhere —
// no pretend CRO (PRD §7 M9 pass, 2nd bullet).

import { build } from "esbuild";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let passCount = 0;
let failCount = 0;

function record(name, ok, detail) {
  if (ok) passCount++;
  else failCount++;
  console.log(`  ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` — ${detail}` : ""}`);
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

async function loadBanditLib() {
  const result = await build({
    entryPoints: [join(ROOT, "lib", "bandit.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2020",
    write: false,
  });
  const code = new TextDecoder().decode(result.outputFiles[0].contents);
  const dir = await mkdtemp(join(tmpdir(), "overlay-bandit-sim-"));
  const tmpFile = join(dir, "bandit.mjs");
  await writeFile(tmpFile, code, "utf-8");
  const mod = await import(`file://${tmpFile}`);
  await unlink(tmpFile).catch(() => {});
  return mod;
}

async function main() {
  const bandit = await loadBanditLib();
  const { runBanditSim, uniformPrior, comPriorFromDelta } = bandit;

  // ── Shared synthetic scenario ──────────────────────────────────────────────────────────
  // Hidden true conversion rates. Control is the page as-is; A/B/C are variants an agent
  // built and the COM scored. C is the real best arm — deliberately not the one with the
  // largest true-rate gap from control, so "best" isn't trivially obvious from the prior.
  const TRUE_RATES = {
    control: 0.1,
    A: 0.115,
    B: 0.095,
    C: 0.14, // true best
  };
  // COM deltas (ComScore.variant - ComScore.control, lib/com.ts) an imperfect-but-directionally
  // -right judge might have produced for each variant against control. Signs/magnitudes track
  // the true ranking (C > A > control > B) without being a perfect oracle.
  const COM_DELTAS = { control: 0, A: 0.04, B: -0.03, C: 0.1 };
  // BASELINE_RATE: the control's own known/assumed conversion rate — comPriorFromDelta anchors
  // its mean here (see lib/bandit.ts doc comment: conversion rates live on a small-percentage
  // scale, so a delta is a RELATIVE lift on the baseline, not an absolute shift toward 0.5).
  const BASELINE_RATE = 0.1;
  const PRIOR_STRENGTH = 15;

  function labeledArms(priorFor) {
    return Object.entries(TRUE_RATES).map(([label, trueRate]) => ({
      label,
      trueRate,
      prior: priorFor(label),
    }));
  }

  console.log("\n=== M9 bandit sim — synthetic traffic only, labeled throughout ===\n");
  console.log(
    `Synthetic arms: ${Object.entries(TRUE_RATES)
      .map(([l, r]) => `${l}=${pct(r)}`)
      .join(", ")} (true best: C)\n`
  );

  // ── Scenario 1: convergence + decreasing regret (COM-informed prior) ───────────────────
  console.log("--- Scenario 1: convergence (COM-informed prior, seed=1, 4000 synthetic visitors) ---");
  const comArms1 = labeledArms((label) => comPriorFromDelta(COM_DELTAS[label], BASELINE_RATE, PRIOR_STRENGTH));
  const sim1 = runBanditSim(comArms1, 4000, 1, 100);

  for (const arm of sim1.arms) {
    console.log(
      `  arm ${arm.label}: trueRate=${pct(arm.trueRate)} pulls=${arm.pulls} conversions=${arm.conversions} posteriorMean=${pct(arm.posteriorMean)}`
    );
  }
  console.log(`  best arm: ${sim1.arms[sim1.bestArmIndex].label}, pull fraction=${pct(sim1.bestArmPullFraction)}`);
  console.log(`  cumulative regret: ${sim1.cumulativeRegret.toFixed(2)}`);

  record(
    "scenario 1: bandit converges on the true-best arm (C gets majority of pulls)",
    sim1.bestArmIndex === 3 && sim1.bestArmPullFraction > 0.5,
    `bestArmIndex=${sim1.bestArmIndex} pullFraction=${pct(sim1.bestArmPullFraction)}`
  );

  const firstWindow = sim1.checkpoints.slice(0, Math.floor(sim1.checkpoints.length * 0.2));
  const lastWindow = sim1.checkpoints.slice(-Math.floor(sim1.checkpoints.length * 0.2));
  const perRoundRegret = (window) => {
    const first = window[0];
    const last = window[window.length - 1];
    return (last.cumulativeRegret - first.cumulativeRegret) / (last.atVisitor - first.atVisitor);
  };
  const earlyRegretRate = perRoundRegret(firstWindow);
  const lateRegretRate = perRoundRegret(lastWindow);
  console.log(
    `  per-round regret: early window=${earlyRegretRate.toFixed(4)}, late window=${lateRegretRate.toFixed(4)}`
  );
  record(
    "scenario 1: regret rate decreases over time (bandit learns, doesn't keep making the same mistakes)",
    lateRegretRate < earlyRegretRate,
    `early=${earlyRegretRate.toFixed(4)} late=${lateRegretRate.toFixed(4)}`
  );

  // ── Scenario 2: COM-prior vs uniform-prior, averaged over many seeds ───────────────────
  console.log(
    "\n--- Scenario 2: COM-informed prior vs uniform prior (30 seeds averaged, 800 synthetic visitors each) ---"
  );
  const SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i);
  const VISITORS_2 = 800;

  function averageOver(seeds, priorFor) {
    let regretSum = 0;
    let bestFractionSum = 0;
    for (const seed of seeds) {
      const arms = labeledArms(priorFor);
      const result = runBanditSim(arms, VISITORS_2, seed, 100);
      regretSum += result.cumulativeRegret;
      bestFractionSum += result.bestArmPullFraction;
    }
    return {
      meanRegret: regretSum / seeds.length,
      meanBestFraction: bestFractionSum / seeds.length,
    };
  }

  const comAvg = averageOver(SEEDS, (label) => comPriorFromDelta(COM_DELTAS[label], BASELINE_RATE, PRIOR_STRENGTH));
  const uniformAvg = averageOver(SEEDS, () => uniformPrior());

  console.log(
    `  COM-informed prior:  mean cumulative regret=${comAvg.meanRegret.toFixed(2)}, mean best-arm pull fraction=${pct(comAvg.meanBestFraction)}`
  );
  console.log(
    `  uniform prior:       mean cumulative regret=${uniformAvg.meanRegret.toFixed(2)}, mean best-arm pull fraction=${pct(uniformAvg.meanBestFraction)}`
  );
  const regretImprovement = 1 - comAvg.meanRegret / uniformAvg.meanRegret;
  const fractionImprovement = comAvg.meanBestFraction / uniformAvg.meanBestFraction - 1;
  console.log(
    `  COM-prior improvement: ${pct(regretImprovement)} lower regret, ${pct(fractionImprovement)} higher best-arm pull rate`
  );

  // A margin (not a bare ">"), so the assertion has room and isn't a coin-flip on a knife's
  // edge: with this scenario/seed set the COM prior's advantage is a robust ~15-20% (verified
  // across multiple seed ranges while tuning) — well clear of a 5% margin.
  record(
    "scenario 2: COM-informed prior reaches meaningfully lower mean cumulative regret than uniform prior (>=5% lower)",
    comAvg.meanRegret < uniformAvg.meanRegret * 0.95,
    `com=${comAvg.meanRegret.toFixed(2)} uniform=${uniformAvg.meanRegret.toFixed(2)} improvement=${pct(regretImprovement)}`
  );
  record(
    "scenario 2: COM-informed prior reaches the best arm meaningfully more often than uniform prior (>=5% higher pull fraction)",
    comAvg.meanBestFraction > uniformAvg.meanBestFraction * 1.05,
    `com=${pct(comAvg.meanBestFraction)} uniform=${pct(uniformAvg.meanBestFraction)} improvement=${pct(fractionImprovement)}`
  );

  // ── Scenario 3: deliberately WRONG prior still gets overridden by traffic ──────────────
  console.log(
    "\n--- Scenario 3: deliberately wrong prior recovers with enough synthetic traffic (seed=7, 6000 visitors) ---"
  );
  // Wrong prior: strongly favors B (the true WORST variant) and strongly disfavors C (the
  // true BEST variant) — the opposite of what a correct COM judgement would produce. This is
  // a synthetic stand-in for "the COM got it backwards."
  const wrongPriorFor = (label) => {
    if (label === "B") return comPriorFromDelta(0.9, BASELINE_RATE, 20); // wrongly confident B is great
    if (label === "C") return comPriorFromDelta(-0.9, BASELINE_RATE, 20); // wrongly confident C is bad
    return comPriorFromDelta(COM_DELTAS[label], BASELINE_RATE, 4);
  };
  const wrongArms = labeledArms(wrongPriorFor);
  const sim3 = runBanditSim(wrongArms, 6000, 7, 200);

  const earlyCheckpoint = sim3.checkpoints[0];
  const lateCheckpoint = sim3.checkpoints[sim3.checkpoints.length - 1];
  const earlyLeader = earlyCheckpoint.pulls.indexOf(Math.max(...earlyCheckpoint.pulls));
  const lateLeader = lateCheckpoint.pulls.indexOf(Math.max(...lateCheckpoint.pulls));

  console.log(
    `  wrong prior means: ${sim3.arms.map((a, i) => `${a.label}=${pct(wrongArms[i].prior.alpha / (wrongArms[i].prior.alpha + wrongArms[i].prior.beta))}`).join(", ")} (B wrongly boosted, C wrongly suppressed — true best is C)`
  );
  console.log(`  early (visitor ${earlyCheckpoint.atVisitor}) pull leader: ${sim3.arms[earlyLeader].label}`);
  console.log(`  late (visitor ${lateCheckpoint.atVisitor}) pull leader: ${sim3.arms[lateLeader].label}`);
  console.log(`  final best-arm (C) pull fraction: ${pct(sim3.bestArmPullFraction)}`);

  record(
    "scenario 3: despite a deliberately wrong prior, the bandit's overall pulls still end up dominated by the true-best arm (C) — traffic overrides the prior",
    sim3.bestArmIndex === 3 && sim3.bestArmPullFraction > 0.5,
    `bestArmIndex=${sim3.bestArmIndex} pullFraction=${pct(sim3.bestArmPullFraction)}`
  );
  record(
    "scenario 3: the late-run pull leader is the true-best arm (C), not whatever the wrong prior favored (B)",
    sim3.arms[lateLeader].label === "C",
    `lateLeader=${sim3.arms[lateLeader].label}`
  );

  console.log(`\n=== Results: ${passCount} passed, ${failCount} failed / ${passCount + failCount} total ===\n`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("bandit-sim: fatal error:", err);
  process.exit(1);
});
