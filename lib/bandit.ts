// lib/bandit.ts — M9 bandit sim (issue #9 / PRD §4.8, §7 M9)
//
// Pure, dependency-free, deterministic functions for a Thompson-sampling bandit simulation
// over SYNTHETIC traffic. Nothing here calls a model or touches the network — the point of
// M9 is to demonstrate the HANDOFF: a COM delta (PRD §4.4, lib/com.ts's `ComScore.delta`)
// seeds a Beta prior belief per arm; live (here: synthetic) traffic then updates the
// posterior via Thompson sampling, and — because it's a real prior, not a hard rule — enough
// traffic overrides a wrong prior. That's the "honest framing" story from PRD §4.4/§4.8.
//
// Everything below is pure math: no `Math.random()` — a seeded PRNG so runs are byte-for-byte
// reproducible (CLAUDE.md: "Seed randomness deterministically"). Imports nothing from
// agent.ts/stores/com.ts (mirrors the com.ts isolation rule: generator/evaluator/bandit are
// three independent, individually-testable layers).

/** A Beta(alpha, beta) distribution's parameters — the posterior belief about an arm's
 *  conversion rate. Mean = alpha / (alpha + beta); higher alpha+beta = more confident. */
export interface BetaParams {
  alpha: number;
  beta: number;
}

/** One simulated arm: a hidden true conversion rate (what a real visitor would do) plus the
 *  Beta prior the bandit starts with (uniform, or COM-informed). */
export interface SimArm {
  label: string;
  trueRate: number;
  prior: BetaParams;
}

export interface ArmResult {
  label: string;
  trueRate: number;
  pulls: number;
  conversions: number;
  posterior: BetaParams;
  posteriorMean: number;
}

/** A snapshot taken periodically during the run — cumulative regret + cumulative per-arm
 *  pulls at that point in time. Lets callers show convergence AND a wrong-prior "recovery"
 *  (early checkpoints favor whatever the prior liked; late checkpoints favor the true best
 *  arm once enough synthetic traffic has arrived). */
export interface SimCheckpoint {
  atVisitor: number;
  cumulativeRegret: number;
  pulls: number[]; // cumulative pulls per arm, indices align with the `arms` input array
}

export interface SimResult {
  arms: ArmResult[];
  bestArmIndex: number;
  bestArmPulls: number;
  bestArmPullFraction: number; // bestArmPulls / total visitors — "did it converge"
  cumulativeRegret: number;
  checkpoints: SimCheckpoint[];
  totalVisitors: number;
  totalConversions: number;
}

// ── Priors ───────────────────────────────────────────────────────────────────────────────

/** The naive baseline: no information, every arm starts equally likely to be best. */
export function uniformPrior(): BetaParams {
  return { alpha: 1, beta: 1 };
}

/**
 * comPriorFromDelta — turns a COM `ComScore.delta` (variant score − control score, in
 * [-1, 1]; see lib/com.ts) into a Beta prior belief anchored around a known baseline
 * conversion rate.
 *
 * Conversion rates live on a small-percentage scale (a few percent to a few tens of a
 * percent), not a 0.5-centered probability scale — a landing page control converting at 10%
 * is normal; one converting at 50% is not. So the delta is applied as a RELATIVE lift on top
 * of `baselineRate` (the control's own known/assumed rate: `mean = baselineRate * (1 +
 * delta)`), not as an absolute shift toward 0.5. Anchoring at 0.5 regardless of scale would
 * make every arm's prior equally (and severely) wrong about the order of magnitude,
 * swamping whatever directional signal the COM delta carries — the informed prior would
 * carry no more real information than the uniform one once the sim has to spend its first
 * many visitors just correcting a wrong order of magnitude for every arm alike.
 *
 * `strength` is the prior's pseudo-count weight (how many "imaginary" visitors worth of
 * confidence the COM judgement is worth). Deliberately small relative to a real experiment's
 * traffic (PRD §4.4: "zero traffic → this is a prior, not conversion data") — the prior
 * nudges early allocation but real synthetic conversions swamp it as pulls accumulate. That's
 * the mechanism, not a side effect: it's what lets a deliberately wrong prior get overridden
 * by traffic (PRD §7 M9 pass, 3rd bullet).
 */
export function comPriorFromDelta(delta: number, baselineRate: number, strength = 8): BetaParams {
  const clampedDelta = Math.max(-1, Math.min(1, delta));
  const mean = clamp(baselineRate * (1 + clampedDelta), 0.005, 0.995);
  const alpha = mean * strength;
  const beta = (1 - mean) * strength;
  return { alpha, beta };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ── Posterior update ────────────────────────────────────────────────────────────────────────

/** Beta-Bernoulli conjugate update: one synthetic visit's outcome moves alpha (on a
 *  conversion) or beta (on a non-conversion) by exactly 1. Pure — returns a new object. */
export function updateBeta(params: BetaParams, converted: boolean): BetaParams {
  return converted
    ? { alpha: params.alpha + 1, beta: params.beta }
    : { alpha: params.alpha, beta: params.beta + 1 };
}

// ── Seeded PRNG (mulberry32) — deterministic, dependency-free ──────────────────────────────

/** makeRng: a tiny, fast, deterministic PRNG seeded by a single 32-bit integer. Same seed =
 *  same infinite stream of [0,1) floats, forever — that's what makes the whole sim
 *  reproducible byte-for-byte across machines/CI runs. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Beta sampling (Marsaglia-Tsang gamma sampler + Beta = Ga/(Ga+Gb)) ──────────────────────

function sampleStandardNormal(rng: () => number): number {
  // Box-Muller transform. Guard u1 away from exactly 0 (log(0) = -Infinity).
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** sampleGamma: Marsaglia & Tsang's method for shape >= 1, boosted for shape < 1 via
 *  Gamma(a) = Gamma(a+1) * U^(1/a). Rate = 1 throughout (we only ever need the Ga/(Ga+Gb)
 *  ratio for Beta sampling, which is rate-invariant as long as both draws share it). */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** sampleBeta: draws one sample from Beta(alpha, beta) via two independent Gamma draws. */
export function sampleBeta(params: BetaParams, rng: () => number): number {
  const x = sampleGamma(params.alpha, rng);
  const y = sampleGamma(params.beta, rng);
  return x / (x + y);
}

// ── Thompson sampling arm selection ─────────────────────────────────────────────────────────

/** selectArmThompson: draws one sample per arm from its current posterior, returns the index
 *  of the arm with the highest sample. This is the whole of Thompson sampling — explore
 *  arms whose posterior is uncertain (wide spread → sometimes samples high), exploit the
 *  arm whose posterior mean is already high. */
export function selectArmThompson(posteriors: BetaParams[], rng: () => number): number {
  let bestIndex = 0;
  let bestSample = -Infinity;
  for (let i = 0; i < posteriors.length; i++) {
    const sample = sampleBeta(posteriors[i], rng);
    if (sample > bestSample) {
      bestSample = sample;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// ── Full simulation loop ────────────────────────────────────────────────────────────────────

/**
 * runBanditSim — the M9 deliverable: simulate `numVisitors` synthetic visitors arriving one
 * at a time. For each, Thompson-sample an arm from current posteriors, "convert" it with
 * probability equal to that arm's HIDDEN true rate (drawn from the same seeded rng, so the
 * whole run is reproducible), then update that arm's posterior. Tracks pulls/conversions per
 * arm, regret (gap to the best true rate, accumulated every pull), and a regret-over-time
 * series so callers can show convergence (regret growth should slow as the bandit learns).
 */
export function runBanditSim(arms: SimArm[], numVisitors: number, seed: number, regretSampleEvery = 50): SimResult {
  if (arms.length === 0) throw new Error("runBanditSim: at least one arm required");
  const rng = makeRng(seed);

  const bestTrueRate = Math.max(...arms.map((a) => a.trueRate));
  const bestArmIndex = arms.findIndex((a) => a.trueRate === bestTrueRate);

  const posteriors: BetaParams[] = arms.map((a) => ({ ...a.prior }));
  const pulls = arms.map(() => 0);
  const conversions = arms.map(() => 0);
  let cumulativeRegret = 0;
  const checkpoints: SimCheckpoint[] = [];

  for (let visitor = 1; visitor <= numVisitors; visitor++) {
    const chosen = selectArmThompson(posteriors, rng);
    pulls[chosen]++;
    cumulativeRegret += bestTrueRate - arms[chosen].trueRate;

    const converted = rng() < arms[chosen].trueRate;
    if (converted) conversions[chosen]++;
    posteriors[chosen] = updateBeta(posteriors[chosen], converted);

    if (visitor % regretSampleEvery === 0 || visitor === numVisitors) {
      checkpoints.push({ atVisitor: visitor, cumulativeRegret, pulls: [...pulls] });
    }
  }

  const armResults: ArmResult[] = arms.map((a, i) => ({
    label: a.label,
    trueRate: a.trueRate,
    pulls: pulls[i],
    conversions: conversions[i],
    posterior: posteriors[i],
    posteriorMean: posteriors[i].alpha / (posteriors[i].alpha + posteriors[i].beta),
  }));

  return {
    arms: armResults,
    bestArmIndex,
    bestArmPulls: pulls[bestArmIndex],
    bestArmPullFraction: pulls[bestArmIndex] / numVisitors,
    cumulativeRegret,
    checkpoints,
    totalVisitors: numVisitors,
    totalConversions: conversions.reduce((s, c) => s + c, 0),
  };
}
