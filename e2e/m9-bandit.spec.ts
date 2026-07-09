/**
 * e2e/m9-bandit.spec.ts — M9 acceptance checklist (issue #9): Thompson-sampling bandit sim
 * over SYNTHETIC traffic, COM prior seeding the starting weights.
 *
 * Fully deterministic and KEYLESS — no ANTHROPIC_API_KEY needed, no live model call anywhere
 * in this milestone (CLAUDE.md: "Anthropic out of credits" constraint; also just correct per
 * PRD §4.8 — M9 is a *simulation* of the handoff, not a live-model feature). Every random
 * draw goes through lib/bandit.ts's seeded `makeRng`, so every assertion below reproduces
 * byte-for-byte on any machine/CI run.
 *
 * Two layers of evidence, same pattern as e2e/m6-eval.spec.ts:
 *  1. Black-box: run the REAL CLI (`node scripts/bandit-sim.mjs`, i.e. `pnpm sim`) as CI
 *     will, and assert its readable report + exit code.
 *  2. White-box: import lib/bandit.ts directly and assert the underlying pure math —
 *     posterior update, seeded-RNG determinism, Thompson selection bias, and the sim's
 *     convergence / COM-prior-vs-uniform / wrong-prior-recovery behavior.
 */

import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  comPriorFromDelta,
  makeRng,
  runBanditSim,
  sampleBeta,
  selectArmThompson,
  uniformPrior,
  updateBeta,
  type BetaParams,
  type SimArm,
} from "../lib/bandit";

const execFileAsync = promisify(execFile);

// ── 1 · black-box: the real `pnpm sim` CLI, exit-coded with a readable per-scenario report ──

test("pnpm sim — bandit sim runs clean, exit 0, readable per-scenario report @m9", async () => {
  const { stdout } = await execFileAsync("node", ["scripts/bandit-sim.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 60_000,
  });

  // Labeled synthetic everywhere — no pretend CRO (PRD §7 M9 pass, 2nd bullet).
  expect(stdout).toMatch(/synthetic/i);
  expect(stdout).toMatch(/true best: C/);

  // Scenario 1: convergence + decreasing regret.
  expect(stdout).toMatch(/Scenario 1: convergence/);
  expect(stdout).toMatch(/PASS — scenario 1: bandit converges on the true-best arm/);
  expect(stdout).toMatch(/PASS — scenario 1: regret rate decreases over time/);

  // Scenario 2: COM-informed prior beats uniform prior — the M9 point.
  expect(stdout).toMatch(/Scenario 2: COM-informed prior vs uniform prior/);
  expect(stdout).toMatch(/PASS — scenario 2: COM-informed prior reaches meaningfully lower mean cumulative regret/);
  expect(stdout).toMatch(/PASS — scenario 2: COM-informed prior reaches the best arm meaningfully more often/);

  // Scenario 3: a deliberately WRONG prior still gets overridden by traffic (honest framing).
  expect(stdout).toMatch(/Scenario 3: deliberately wrong prior recovers/);
  expect(stdout).toMatch(/PASS — scenario 3: despite a deliberately wrong prior.*traffic overrides the prior/);
  expect(stdout).toMatch(/PASS — scenario 3: the late-run pull leader is the true-best arm/);

  // Clean pass/fail summary, 0 failures.
  expect(stdout).toMatch(/=== Results: 6 passed, 0 failed \/ 6 total ===/);
  // (execFileAsync would itself throw on a non-zero exit code — reaching here already proves
  // exit 0; the assertion above is the readable-report half of the acceptance item.)
});

// ── 2 · white-box: the pure math behind the sim ──────────────────────────────────────────

test("updateBeta: Beta-Bernoulli posterior update is exact arithmetic @m9", () => {
  const prior: BetaParams = { alpha: 3, beta: 5 };
  const afterConversion = updateBeta(prior, true);
  const afterNonConversion = updateBeta(prior, false);

  expect(afterConversion).toEqual({ alpha: 4, beta: 5 });
  expect(afterNonConversion).toEqual({ alpha: 3, beta: 6 });
  // Pure: original object untouched.
  expect(prior).toEqual({ alpha: 3, beta: 5 });
});

test("comPriorFromDelta: mean is a relative lift on the baseline rate, strength sets pseudo-count weight @m9", () => {
  const baseline = 0.1;

  const neutral = comPriorFromDelta(0, baseline, 10);
  expect(neutral.alpha / (neutral.alpha + neutral.beta)).toBeCloseTo(0.1, 5);
  expect(neutral.alpha + neutral.beta).toBeCloseTo(10, 5);

  const positive = comPriorFromDelta(0.5, baseline, 10);
  expect(positive.alpha / (positive.alpha + positive.beta)).toBeCloseTo(0.15, 5); // 0.1 * 1.5

  const negative = comPriorFromDelta(-0.5, baseline, 10);
  expect(negative.alpha / (negative.alpha + negative.beta)).toBeCloseTo(0.05, 5); // 0.1 * 0.5

  // Delta is clamped to [-1, 1] — an out-of-range delta doesn't blow the mean past the clamp.
  const clamped = comPriorFromDelta(5, baseline, 10);
  expect(clamped.alpha / (clamped.alpha + clamped.beta)).toBeCloseTo(0.2, 5); // baseline * (1+1)
});

test("makeRng: seeded PRNG is deterministic — same seed replays the identical stream @m9", () => {
  const streamA = makeRng(42);
  const streamB = makeRng(42);
  const valuesA = Array.from({ length: 20 }, () => streamA());
  const valuesB = Array.from({ length: 20 }, () => streamB());
  expect(valuesA).toEqual(valuesB);

  // Every value is a valid probability.
  for (const v of valuesA) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }

  // A different seed gives a different stream (sanity: not a constant function).
  const streamC = makeRng(43);
  const valuesC = Array.from({ length: 20 }, () => streamC());
  expect(valuesC).not.toEqual(valuesA);
});

test("sampleBeta: samples respect the Beta distribution's support and lean toward its mean @m9", () => {
  const rng = makeRng(7);
  const skewedHigh: BetaParams = { alpha: 90, beta: 10 }; // mean 0.9, tight
  const samples = Array.from({ length: 200 }, () => sampleBeta(skewedHigh, rng));
  for (const s of samples) {
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  expect(mean).toBeGreaterThan(0.8); // clusters near the true 0.9 mean, deterministic seed
});

test("selectArmThompson: a strongly-confident high-mean arm is selected far more often than a strongly-confident low-mean arm @m9", () => {
  const rng = makeRng(123);
  const posteriors: BetaParams[] = [
    { alpha: 500, beta: 5 }, // arm 0: mean ~0.99, very confident
    { alpha: 5, beta: 500 }, // arm 1: mean ~0.01, very confident
  ];
  let arm0Count = 0;
  for (let i = 0; i < 200; i++) {
    if (selectArmThompson(posteriors, rng) === 0) arm0Count++;
  }
  // Deterministic seed — with this much separation, arm 0 should win almost every draw.
  expect(arm0Count).toBeGreaterThan(190);
});

test("runBanditSim: identical inputs + seed produce byte-identical results (reproducibility) @m9", () => {
  const arms: SimArm[] = [
    { label: "control", trueRate: 0.1, prior: uniformPrior() },
    { label: "variant", trueRate: 0.2, prior: uniformPrior() },
  ];
  const resultA = runBanditSim(arms, 500, 99, 50);
  const resultB = runBanditSim(arms, 500, 99, 50);
  expect(resultA).toEqual(resultB);
});

test("runBanditSim: converges to the true-best arm and regret decreases over time @m9", () => {
  const arms: SimArm[] = [
    { label: "control", trueRate: 0.08, prior: uniformPrior() },
    { label: "variant", trueRate: 0.2, prior: uniformPrior() }, // clearly best
  ];
  const result = runBanditSim(arms, 3000, 1, 100);

  expect(result.bestArmIndex).toBe(1);
  expect(result.bestArmPullFraction).toBeGreaterThan(0.6); // majority of traffic goes to the winner

  const firstCheckpoint = result.checkpoints[0];
  const lastCheckpoint = result.checkpoints[result.checkpoints.length - 1];
  const earlyRate =
    firstCheckpoint.cumulativeRegret / firstCheckpoint.atVisitor;
  const lateRate =
    (lastCheckpoint.cumulativeRegret - firstCheckpoint.cumulativeRegret) /
    (lastCheckpoint.atVisitor - firstCheckpoint.atVisitor);
  expect(lateRate).toBeLessThan(earlyRate); // per-round regret shrinks as the bandit learns
});

test("runBanditSim: a COM-informed prior reaches lower cumulative regret than a uniform prior (same true rates, same seeds) @m9", () => {
  const trueRates = { control: 0.1, A: 0.115, B: 0.095, C: 0.14 };
  const comDeltas = { control: 0, A: 0.04, B: -0.03, C: 0.1 };
  const baseline = 0.1;
  const strength = 15;
  const visitors = 800;
  const seeds = Array.from({ length: 30 }, (_, i) => 1000 + i);

  function armsWith(priorFor: (label: string) => BetaParams): SimArm[] {
    return Object.entries(trueRates).map(([label, trueRate]) => ({
      label,
      trueRate,
      prior: priorFor(label),
    }));
  }

  function meanRegretAndBestFraction(priorFor: (label: string) => BetaParams) {
    let regretSum = 0;
    let bestFractionSum = 0;
    for (const seed of seeds) {
      const result = runBanditSim(armsWith(priorFor), visitors, seed, 100);
      regretSum += result.cumulativeRegret;
      bestFractionSum += result.bestArmPullFraction;
    }
    return { meanRegret: regretSum / seeds.length, meanBestFraction: bestFractionSum / seeds.length };
  }

  const comInformed = meanRegretAndBestFraction((label) =>
    comPriorFromDelta(comDeltas[label as keyof typeof comDeltas], baseline, strength)
  );
  const uniform = meanRegretAndBestFraction(() => uniformPrior());

  // Margin, not a bare inequality — the COM-informed prior's advantage in this deterministic
  // scenario is a robust ~15% (see scripts/bandit-sim.mjs's tuning comment); 5% leaves room.
  expect(comInformed.meanRegret).toBeLessThan(uniform.meanRegret * 0.95);
  expect(comInformed.meanBestFraction).toBeGreaterThan(uniform.meanBestFraction * 1.05);
});

test("runBanditSim: a deliberately wrong prior still gets overridden by enough synthetic traffic @m9", () => {
  const trueRates = { control: 0.1, A: 0.115, B: 0.095, C: 0.14 }; // C is the true best
  const baseline = 0.1;

  // Wrong prior: strongly believes B (the true worst variant) is great, and C (the true
  // best) is bad — the opposite of a correct COM judgement.
  const wrongPriorFor = (label: string): BetaParams => {
    if (label === "B") return comPriorFromDelta(0.9, baseline, 20);
    if (label === "C") return comPriorFromDelta(-0.9, baseline, 20);
    return comPriorFromDelta(0, baseline, 4);
  };
  const arms: SimArm[] = Object.entries(trueRates).map(([label, trueRate]) => ({
    label,
    trueRate,
    prior: wrongPriorFor(label),
  }));

  const result = runBanditSim(arms, 6000, 7, 200);

  // Despite the wrong prior, the true-best arm (C) still ends up dominating overall pulls —
  // traffic overrides the prior (PRD §7 M9 pass, 3rd bullet / "honest framing").
  expect(result.bestArmIndex).toBe(3); // index of "C" in Object.entries order
  expect(result.arms[result.bestArmIndex].label).toBe("C");
  expect(result.bestArmPullFraction).toBeGreaterThan(0.5);

  // And by the end of the run, C — not the wrongly-favored B — is the leading arm.
  const lastCheckpoint = result.checkpoints[result.checkpoints.length - 1];
  const lateLeaderIndex = lastCheckpoint.pulls.indexOf(Math.max(...lastCheckpoint.pulls));
  expect(result.arms[lateLeaderIndex].label).toBe("C");
});
