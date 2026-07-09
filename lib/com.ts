// COM — Conversion Optimization Model (lib/com.ts)
// Isolation rule: imports NOTHING from agent.ts or stores. Only: ai, @ai-sdk/anthropic, zod, types.
// Generator ≠ evaluator: the agent never sees this rubric; the COM prompt states the goal but
// never enumerates what "good" looks like.
//
// Issue #45 (part of #43, deterministic-first pipeline): the scorer's DEFAULT path is a
// deterministic heuristic core (`computeDeterministicScore`) that reads ONLY the two variants'
// slot text (+ optional per-slot facts) and the brief — never how a variant was produced. It
// needs no model call, so it works with zero credits/key and is fully unit-testable. When a key
// (or an injected provider) is present, `scoreVariant` optionally calls the existing LLM judge
// and BLENDS it in as a refinement layer — it never gates: any LLM failure (network, bad key,
// out of credits) is caught and the deterministic score is returned as-is.

import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { ComScore, PageBrief } from "./types";

// SlotSnapshot = one entry per CHANGED node (before/after of changed nodes only).
// `facts` is optional and keyed by slot name, mirroring a subset of PageNode.facts
// (lib/types.ts) — when present, feeds the deterministic accessibility-regression signal.
export interface SlotSnapshot {
  path: string;
  slots: Record<string, string>;
  facts?: Record<string, { contrast?: number; missingAlt?: boolean }>;
}

// ---------------------------------------------------------------------------------------------
// Deterministic core — pure, synchronous, no network. `computeDeterministicScore` is the DEFAULT
// scoring path (issue #45). Combine five signals into one signed delta:
//   1. Specificity/proof vs vague-genericness ("concreteness")
//   2. Brief fit — ICP/value-prop keyword coverage
//   2b. Objection handling — coverage of the brief's UNHANDLED objections specifically
//   3. Clarity of ask — CTA verb strength/presence
//   4. Readability/length — bloat penalty
//   5. Accessibility — contrast/alt regressions (warn-only, reuses node facts when supplied)
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "your", "you", "are", "who", "our",
  "from", "have", "has", "not", "but", "can", "will", "was", "were", "into", "than",
  "them", "they", "their", "its", "it's", "without", "want", "wants", "wanted",
  "get", "gets", "getting", "when", "what", "how", "why", "all", "any", "each",
  "more", "most", "some", "such", "only", "own", "same", "too", "very", "just",
  "let", "lets", "use", "uses", "using", "make", "makes", "over", "out", "off",
  "run", "runs", "running", "one", "and", "won't", "wont", "take", "whole", "does",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w) && w.length >= 4);
}

// Concatenate all non-URL slot text from a snapshot list into one prose corpus.
function corpusOf(snapshots: SlotSnapshot[]): string {
  const parts: string[] = [];
  for (const s of snapshots) {
    for (const [key, val] of Object.entries(s.slots)) {
      if (key === "href" || key === "src") continue; // URLs aren't prose
      if (typeof val === "string" && val.trim().length > 0) parts.push(val);
    }
  }
  return parts.join(" ");
}

// CTA-shaped slot text: slots keyed "text" that ride alongside an "href" (a link/CTA), or any
// slot on a path that mentions "cta".
function ctaTextsOf(snapshots: SlotSnapshot[]): string[] {
  const out: string[] = [];
  for (const s of snapshots) {
    const isCtaPath = /cta/i.test(s.path);
    for (const [key, val] of Object.entries(s.slots)) {
      if (typeof val !== "string" || !val.trim()) continue;
      if (key === "text" && ("href" in s.slots || isCtaPath)) out.push(val);
    }
  }
  return out;
}

const PROOF_WORDS = [
  "free", "proven", "rated", "trusted", "guarantee", "guaranteed", "certified",
  "verified", "testimonial", "case study", "reviews",
];

const VAGUE_WORDS = [
  "solutions", "solution", "innovative", "innovation", "cutting-edge", "cutting edge",
  "world-class", "best-in-class", "leverage", "synergy", "empower", "seamless",
  "game-changer", "game changer", "revolutionize", "robust", "end-to-end", "holistic",
  "turnkey", "everyone", "grow and succeed", "unlock your potential", "state-of-the-art",
];

function proofScore(text: string): number {
  const lower = text.toLowerCase();
  const numHits = (text.match(/\d[\d,.]*\s*%?/g) ?? []).length;
  const wordHits = PROOF_WORDS.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
  return numHits + wordHits;
}

function vagueScore(text: string): number {
  const lower = text.toLowerCase();
  return VAGUE_WORDS.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
}

// Net "concreteness" = proof signals minus vague-genericness signals. A copy change that adds
// numbers/proof words is more concrete (positive); one that adds filler marketing-speak
// ("solutions", "innovative", "seamless"...) or loses proof is less concrete (negative). This is
// the same signal that flags an adversarial "make it vague and generic" rewrite as negative.
function concretenessDelta(controlText: string, variantText: string): number {
  const c = proofScore(controlText) - vagueScore(controlText);
  const v = proofScore(variantText) - vagueScore(variantText);
  return v - c;
}

const STRONG_CTA_WORDS = [
  "start", "try", "join", "sign up", "signup", "subscribe", "download", "claim",
  "unlock", "get started", "get the", "free",
];
const WEAK_CTA_WORDS = [
  "click here", "submit", "request a demo", "request demo", "contact sales",
  "talk to sales", "book a call", "call us",
];

function ctaStrength(text: string): number {
  if (!text.trim()) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of STRONG_CTA_WORDS) if (lower.includes(w)) score += 1;
  for (const w of WEAK_CTA_WORDS) if (lower.includes(w)) score -= 1;
  return score;
}

function keywordCoverage(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const lower = text.toLowerCase();
  const hits = keywords.filter((k) => lower.includes(k)).length;
  return hits / keywords.length;
}

// ICP / value-prop / missed-pain-point / unhandled-objection language — everything the brief
// flags as either the target audience's framing or a currently-unaddressed gap.
function briefKeywords(brief: PageBrief | null): string[] {
  if (!brief) return [];
  const src = [brief.icp, brief.valueProp, ...(brief.painPoints?.missed ?? [])].join(" ");
  return Array.from(new Set(tokenize(src)));
}

function objectionKeywords(brief: PageBrief | null): string[] {
  if (!brief) return [];
  return Array.from(new Set(tokenize((brief.objections?.unhandled ?? []).join(" "))));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Length/readability — a bloat-only penalty: 3x+ length growth is a readability regression
// regardless of content quality.
function lengthSignal(controlText: string, variantText: string): { delta: number; reason?: string } {
  const wc = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
  const cLen = wc(controlText);
  const vLen = wc(variantText);
  if (cLen === 0) return { delta: 0 };
  const ratio = vLen / cLen;
  if (ratio >= 3) {
    return { delta: -0.06, reason: `variant is ${ratio.toFixed(1)}x longer than control — bloat risk` };
  }
  return { delta: 0 };
}

// Accessibility — contrast/alt regressions between the same path's control facts and variant
// facts (warn-only: absence of `facts` on either side is simply not scored, per the "reuse the
// warn-only checks" note in issue #45). WCAG AA text-contrast floor is 4.5:1.
function a11ySignal(control: SlotSnapshot[], variant: SlotSnapshot[]): { delta: number; reason?: string } {
  let delta = 0;
  let reason: string | undefined;
  for (const v of variant) {
    if (!v.facts) continue;
    const c = control.find((s) => s.path === v.path);
    for (const [slot, vf] of Object.entries(v.facts)) {
      const cf = c?.facts?.[slot];
      if (vf.missingAlt && !cf?.missingAlt) {
        delta -= 0.08;
        reason = `${v.path}.${slot} lost its alt text`;
      }
      if (typeof vf.contrast === "number" && vf.contrast < 4.5 && !(cf?.contrast !== undefined && cf.contrast < 4.5)) {
        delta -= 0.08;
        reason = `${v.path}.${slot} contrast dropped to ${vf.contrast.toFixed(1)}:1 (below WCAG AA 4.5:1)`;
      }
    }
  }
  return { delta, reason };
}

export interface DeterministicInput {
  brief: PageBrief | null;
  goal: string;
  control: SlotSnapshot[];
  variant: SlotSnapshot[];
}

/** computeDeterministicScore: the deterministic heuristic core (issue #45). Pure + synchronous
 *  — no model call, no network, no imports beyond ./types. Reads only the two variants'
 *  slot text/facts + the brief (never how a variant was produced — generator ≠ evaluator). */
export function computeDeterministicScore(input: DeterministicInput): ComScore {
  const controlText = corpusOf(input.control);
  const variantText = corpusOf(input.variant);

  const weighted: { weight: number; text: string }[] = [];
  let delta = 0;

  // 1. Specificity/proof vs vague-genericness.
  const concDelta = concretenessDelta(controlText, variantText);
  if (concDelta !== 0) {
    const w = clamp(concDelta * 0.04, -0.16, 0.16);
    delta += w;
    weighted.push({
      weight: Math.abs(w),
      text:
        concDelta > 0
          ? `more concrete: proof/specificity signals increased by ${concDelta}`
          : `copy got vaguer/more generic (concreteness dropped by ${Math.abs(concDelta)})`,
    });
  }

  // 2. Brief fit — ICP/value-prop/missed-pain-point keyword coverage.
  const kws = briefKeywords(input.brief);
  if (kws.length > 0) {
    const covC = keywordCoverage(controlText, kws);
    const covV = keywordCoverage(variantText, kws);
    const w = clamp((covV - covC) * 0.5, -0.2, 0.2);
    if (Math.abs(w) > 0.001) {
      delta += w;
      weighted.push({
        weight: Math.abs(w),
        text:
          w > 0
            ? `covers more ICP/value-prop language (${Math.round(covV * 100)}% vs ${Math.round(covC * 100)}% keyword coverage)`
            : `drifts from the brief's ICP/value-prop language (${Math.round(covV * 100)}% vs ${Math.round(covC * 100)}% keyword coverage)`,
      });
    }
  }

  // 2b. Objection handling — coverage of the brief's UNHANDLED objections specifically
  // (weighted independently so a variant that closes a named gap gets credit even if overall
  // ICP/value-prop coverage barely moves).
  const objKws = objectionKeywords(input.brief);
  if (objKws.length > 0) {
    const lowerC = controlText.toLowerCase();
    const lowerV = variantText.toLowerCase();
    const covC = keywordCoverage(controlText, objKws);
    const covV = keywordCoverage(variantText, objKws);
    if (covV > covC) {
      const matched = objKws.find((k) => lowerV.includes(k) && !lowerC.includes(k));
      delta += 0.12;
      weighted.push({
        weight: 0.12,
        text: `addresses a previously-unhandled objection${matched ? ` ("${matched}")` : ""}`,
      });
    } else if (covV < covC) {
      delta -= 0.08;
      weighted.push({ weight: 0.08, text: "drops previously-covered objection-handling language" });
    }
  }

  // 3. Clarity of ask — CTA verb strength/presence.
  const ctaC = ctaTextsOf(input.control).join(" ");
  const ctaV = ctaTextsOf(input.variant).join(" ");
  if (ctaC.trim() || ctaV.trim()) {
    const sC = ctaStrength(ctaC);
    const sV = ctaStrength(ctaV);
    const w = clamp((sV - sC) * 0.06, -0.18, 0.18);
    if (Math.abs(w) > 0.001) {
      delta += w;
      weighted.push({
        weight: Math.abs(w),
        text:
          w > 0
            ? `CTA reads as a stronger, lower-friction ask ("${ctaV.trim() || ctaC.trim()}")`
            : `CTA moved toward a vaguer or higher-friction ask ("${ctaV.trim() || ctaC.trim()}")`,
      });
    }
  }

  // 4. Readability/length — bloat penalty.
  const len = lengthSignal(controlText, variantText);
  if (len.delta !== 0) {
    delta += len.delta;
    weighted.push({ weight: Math.abs(len.delta), text: len.reason! });
  }

  // 5. Accessibility — contrast/alt regressions (only scored when facts are supplied).
  const a11y = a11ySignal(input.control, input.variant);
  if (a11y.delta !== 0) {
    delta += a11y.delta;
    weighted.push({ weight: Math.abs(a11y.delta), text: a11y.reason! });
  }

  delta = clamp(delta, -0.9, 0.9);
  const control = 0.5; // neutral baseline — the heuristic scores a RELATIVE delta, not an
  // absolute conversion-likelihood estimate; see the "score both, delta is the story" contract
  // in ComScore (lib/types.ts).
  const variant = clamp(control + delta, 0, 1);
  const trueDelta = variant - control; // recompute post-clamp so delta === variant - control always

  const confidence = clamp(0.35 + Math.min(0.55, Math.abs(trueDelta) * 1.2 + weighted.length * 0.04), 0, 1);

  weighted.sort((a, b) => b.weight - a.weight);
  const reasons = weighted.slice(0, 4).map((r) => r.text);
  if (reasons.length === 0) reasons.push("no measurable differences detected between control and variant");

  return { control, variant, delta: trueDelta, confidence, reasons };
}

// ---------------------------------------------------------------------------------------------
// Optional LLM refinement layer (unchanged rubric/prompt from the original judge).
// ---------------------------------------------------------------------------------------------

// COM_SYSTEM: states the goal, never enumerates criteria.
// Placed here (not in prompts.ts) to avoid any file overlap with issue #1's work.
const COM_SYSTEM = `You are an independent conversion-rating model. Input: a page's conversion brief (may be null), a goal, and before/after content for the changed components. Rate control and variant separately (0–1) for how likely each is to achieve the goal for this audience. Judge only what you see; do not assume the variant is better because it is newer. Reasons: concrete, ≤4, terse.`;

const comScoreSchema = z.object({
  control: z.number().min(0).max(1),
  variant: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(4),
});

async function scoreVariantLLM(
  input: DeterministicInput,
  provider?: ReturnType<typeof createAnthropic>
): Promise<ComScore> {
  const anthropic =
    provider ??
    createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    });

  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: comScoreSchema,
    system: COM_SYSTEM,
    prompt: JSON.stringify(input),
  });

  return { ...object, delta: object.variant - object.control };
}

// Blend the deterministic core with the LLM refinement: average the two deltas, keep the LLM's
// absolute control anchor (it has more context than the neutral 0.5 baseline), recompute variant
// from the blended delta so delta === variant - control always holds, union+cap reasons at 4.
function blend(det: ComScore, llm: ComScore): ComScore {
  const control = llm.control;
  const rawDelta = (det.delta + llm.delta) / 2;
  const variant = clamp(control + rawDelta, 0, 1);
  const delta = variant - control;
  const confidence = Math.max(det.confidence, llm.confidence);
  const reasons = Array.from(new Set([...llm.reasons, ...det.reasons])).slice(0, 4);
  return { control, variant, delta, confidence, reasons };
}

/** scoreVariant: deterministic-first (issue #45/#43). Computes the heuristic core with NO model
 *  call — this is the default, keyless, always-available path. If a key (env var) or an
 *  injected provider is present, ALSO calls the existing LLM judge and blends it in as a
 *  refinement layer; any LLM failure (network, bad/expired key, out of credits) is caught and
 *  the deterministic score is returned unchanged — the model enhances, it never gates. */
export async function scoreVariant(
  input: DeterministicInput,
  provider?: ReturnType<typeof createAnthropic>
): Promise<ComScore> {
  const deterministic = computeDeterministicScore(input);

  const hasKeyOrProvider = !!provider || !!process.env.ANTHROPIC_API_KEY;
  if (!hasKeyOrProvider) return deterministic;

  try {
    const llm = await scoreVariantLLM(input, provider);
    return blend(deterministic, llm);
  } catch {
    return deterministic;
  }
}
