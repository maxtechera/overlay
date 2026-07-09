/**
 * lib/export.ts — TECH-SPEC §12 / PRD §4.7: the variant (or experiment) as a deployable,
 * dependency-free A/B script. Pure — no store imports, no `send`, no LLM: the caller (the
 * `export` ChatBlock, components/Export.tsx) resolves node ids to SelectorRefs from
 * useSchemaStore and hands this module already-resolved data, the same isolation pattern as
 * lib/variants.ts's `suggestedAllocation` (a pure formula the store-aware caller feeds).
 *
 * Re-find rule (PRD §11 hard part #5): SelectorRef + fingerprint are ONLY valid for re-attach
 * after reload and for THIS export snippet — both run against the ORIGINAL, unedited page. The
 * fingerprint is the CONTAINER's normalized textContent captured at extraction time (the exact
 * value lib/runtime.ts's `buildSelector` already computed into `PageNode.selector`). The
 * generated applier re-derives each node's actual SLOT sub-element (headline/subhead/cta/…)
 * with a small heuristic mirroring runtime.ts's `getSlotElement` fallback rules — duplicated
 * (not imported: the exported snippet must stay dependency-free and never import runtime.ts,
 * which is never present on a third-party site).
 */

import type { Op, SelectorRef, VariantOp } from "./types";

// ── standalone op shape (what actually ships in the snippet) ───────────────────────────────

export interface StandaloneOp {
  css: string;
  fingerprint?: string;
  slots: Op["slots"];
}

export type ExportSignal =
  | { kind: "param"; param: string; value: string }
  | { kind: "referrer"; contains: string }
  | { kind: "device"; device: "mobile" | "desktop" };

export interface ExportArm {
  id: string;
  w: number;
  ops: StandaloneOp[];
}

export interface ExportSpec {
  key: string; // localStorage key — embeds the experiment/variant id (TECH-SPEC §12)
  mode: "ab" | "segment";
  arms: ExportArm[]; // always includes a "control" arm with ops: []
  signal?: ExportSignal; // segment mode only
}

// ── build StandaloneOps from a variant's applied VariantOps ────────────────────────────────

/**
 * Merge a variant's APPLIED ops by target node, in first-appearance order, later ops
 * overwriting earlier same-slot values (matches the final on-page state — a variant that
 * touches the same node's slots across multiple ops still exports as ONE standalone op per
 * node). `selectorOf` looks up a node's SelectorRef (e.g.
 * `useSchemaStore.getState().node(id)?.selector`) — injected so this stays pure and directly
 * unit-testable (e2e/m5-export.spec.ts) without a live store. Ops whose target no longer
 * resolves to a node are silently dropped (nothing to export for them).
 */
export function mergeOpsByTarget(
  vops: VariantOp[],
  selectorOf: (targetId: string) => SelectorRef | undefined
): StandaloneOp[] {
  const order: string[] = [];
  const slotsByTarget: Record<string, Op["slots"]> = {};
  for (const vop of vops) {
    if (vop.status !== "applied") continue;
    const targetId = vop.op.target;
    if (!(targetId in slotsByTarget)) {
      order.push(targetId);
      slotsByTarget[targetId] = {};
    }
    slotsByTarget[targetId] = { ...slotsByTarget[targetId], ...vop.op.slots };
  }

  const out: StandaloneOp[] = [];
  for (const targetId of order) {
    const selector = selectorOf(targetId);
    if (!selector) continue;
    out.push({ css: selector.css, fingerprint: selector.fingerprint, slots: slotsByTarget[targetId] });
  }
  return out;
}

// ── spec builders (PRD §4.7 / TECH-SPEC §12) ────────────────────────────────────────────────

/**
 * Single-variant export = the degenerate 2-arm case (PRD §7 M5 pass): control/variant 50/50,
 * literal arm id "variant" (TECH-SPEC §12's pseudocode — "bucket forced to 'variant'" for the
 * console path only makes sense if the non-control arm's id IS literally "variant").
 */
export function specForVariant(ops: StandaloneOp[], key: string): ExportSpec {
  return {
    key,
    mode: "ab",
    arms: [
      { id: "control", w: 0.5, ops: [] },
      { id: "variant", w: 0.5, ops },
    ],
  };
}

/**
 * Multi-arm export (an Experiment's arms together): weighted by the COM-prior suggested
 * allocation (lib/variants.ts's `suggestedAllocation`), or an equal split across control + arms
 * if no allocation is supplied. Arm ids are the variants' own ids — several named arms need
 * disambiguation, unlike the single-variant "variant" shorthand.
 */
export function specForExperiment(
  arms: { id: string; ops: StandaloneOp[] }[],
  allocation: Record<string, number> | undefined,
  key: string
): ExportSpec {
  const equalShare = arms.length > 0 ? 1 / (arms.length + 1) : 1;
  return {
    key,
    mode: "ab",
    arms: [
      { id: "control", w: allocation?.control ?? equalShare, ops: [] },
      ...arms.map((a) => ({ id: a.id, w: allocation?.[a.id] ?? equalShare, ops: a.ops })),
    ],
  };
}

/**
 * Segment mode (PRD §4.7): applies ONLY when `signal` matches — rule-based, deterministic, no
 * persistence. Weights are irrelevant in segment mode (the applier never buckets/persists
 * there) but the ExportSpec shape still carries one per arm for consistency.
 */
export function specForSegment(ops: StandaloneOp[], signal: ExportSignal, key: string): ExportSpec {
  return {
    key,
    mode: "segment",
    signal,
    arms: [
      { id: "control", w: 0, ops: [] },
      { id: "variant", w: 1, ops },
    ],
  };
}

// ── the applier (TECH-SPEC §12) ─────────────────────────────────────────────────────────────

function jsonForJs(value: unknown): string {
  // JSON is a valid JS expression EXCEPT U+2028/2029 (illegal inside string literals on some
  // parsers) — escape them so the emitted script never silently breaks on page text containing
  // one (a real, if rare, hazard for text pulled off a live page).
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export interface BuildApplierOpts {
  forceArmId?: string; // "console version" — hardcode the bucket, skip bucketing/persistence
}

/**
 * The dependency-free IIFE applier (TECH-SPEC §12): bucket (or force), expose
 * `window.__overlayVariant` + `data-overlay-variant`, re-find each op's container via
 * `querySelector(css)` + fingerprint check (drop-and-warn on mismatch, NEVER guess), re-find the
 * specific slot sub-element with a small heuristic, apply. Zero network calls, zero imports.
 * Applies immediately if the document is already parsed (console paste), else waits for
 * DOMContentLoaded (script tag pasted in <head>).
 */
export function buildApplierSource(spec: ExportSpec, opts?: BuildApplierOpts): string {
  return `(function () {
  var KEY = ${jsonForJs(spec.key)};
  var MODE = ${jsonForJs(spec.mode)};
  var SIGNAL = ${jsonForJs(spec.signal ?? null)};
  var ARMS = ${jsonForJs(spec.arms)};
  var FORCE = ${jsonForJs(opts?.forceArmId ?? null)};

  function normText(t) {
    return String(t == null ? "" : t).replace(/\\s+/g, " ").trim().slice(0, 40);
  }

  function isVisible(el) {
    try {
      var cs = window.getComputedStyle(el);
      return cs.display !== "none" && cs.visibility !== "hidden";
    } catch (e) {
      return true;
    }
  }

  // Re-find a slot's sub-element inside its already-refound container — mirrors
  // lib/runtime.ts's getSlotElement fallback rules (headline/subhead/cta/...), duplicated here
  // (never imported) since this snippet must stay dependency-free.
  function findSlotEl(container, slotName) {
    if (slotName === "headline" || slotName === "heading" || slotName === "title") {
      if (/^H[1-6]$/.test(container.tagName) || container.getAttribute("role") === "heading") return container;
      return container.querySelector("h1,h2,h3,h4,[role=heading]");
    }
    if (slotName === "subhead") {
      var heading = container.querySelector("h1,h2,h3,[role=heading]");
      var sib = heading ? heading.nextElementSibling : null;
      while (sib) {
        if (isVisible(sib)) return sib;
        sib = sib.nextElementSibling;
      }
      return null;
    }
    if (slotName === "cta" || slotName === "link") {
      if (container.tagName === "A" || container.tagName === "BUTTON") return container;
      return container.querySelector("a,button");
    }
    if (slotName === "body" || slotName === "description") {
      var heading2 = container.querySelector("h1,h2,h3,h4");
      var ps = container.querySelectorAll("p");
      for (var i = 0; i < ps.length; i++) {
        if (ps[i] !== heading2) return ps[i];
      }
      return null;
    }
    if (slotName === "media") {
      if (container.tagName === "IMG") return container;
      return container.querySelector("img");
    }
    if (slotName === "text") return container;
    return null;
  }

  function matchesSignal() {
    if (!SIGNAL) return false;
    try {
      if (SIGNAL.kind === "param") {
        return new URLSearchParams(location.search).get(SIGNAL.param) === SIGNAL.value;
      }
      if (SIGNAL.kind === "referrer") {
        return document.referrer.indexOf(SIGNAL.contains) !== -1;
      }
      if (SIGNAL.kind === "device") {
        var mobile = /Mobi|Android/i.test(navigator.userAgent);
        return SIGNAL.device === "mobile" ? mobile : !mobile;
      }
    } catch (e) {}
    return false;
  }

  function armById(id) {
    for (var i = 0; i < ARMS.length; i++) if (ARMS[i].id === id) return ARMS[i];
    return null;
  }

  function pickBucket() {
    if (FORCE) return FORCE;
    if (MODE === "segment") {
      var variantArm = null;
      for (var i = 0; i < ARMS.length; i++) {
        if (ARMS[i].id !== "control") { variantArm = ARMS[i]; break; }
      }
      return variantArm && matchesSignal() ? variantArm.id : "control";
    }
    var stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) {}
    if (stored && armById(stored)) return stored;
    var r = Math.random(), acc = 0, chosen = "control";
    for (var j = 0; j < ARMS.length; j++) {
      acc += ARMS[j].w;
      if (r < acc) { chosen = ARMS[j].id; break; }
    }
    try { localStorage.setItem(KEY, chosen); } catch (e) {}
    return chosen;
  }

  function applyArm(arm) {
    for (var i = 0; i < arm.ops.length; i++) {
      var op = arm.ops[i];
      var container = null;
      try { container = document.querySelector(op.css); } catch (e) { container = null; }
      if (!container) {
        console.warn("[overlay] drop " + op.css + " — not found");
        continue;
      }
      if (op.fingerprint != null && normText(container.textContent) !== op.fingerprint) {
        console.warn("[overlay] drop " + op.css + " — fingerprint mismatch");
        continue;
      }
      var slots = op.slots || {};
      var slotNames = Object.keys(slots);
      for (var s = 0; s < slotNames.length; s++) {
        var slotName = slotNames[s];
        var slotVal = slots[slotName];
        var el = findSlotEl(container, slotName);
        if (!el) {
          console.warn("[overlay] drop " + op.css + "." + slotName + " — slot not found");
          continue;
        }
        if (slotVal.text !== undefined) el.textContent = slotVal.text;
        if (slotVal.href !== undefined && "href" in el) el.href = slotVal.href;
        if (slotVal.src !== undefined && "src" in el) el.src = slotVal.src;
        if (slotVal.alt !== undefined && "alt" in el) el.alt = slotVal.alt;
      }
    }
  }

  function run() {
    var bucket = pickBucket();
    // #overlay-force-variant (TECH-SPEC §12, the console/preview path): force the first
    // non-control arm even when the <script> tag is already deployed — never persisted.
    try {
      if (location.hash === "#overlay-force-variant") {
        for (var f = 0; f < ARMS.length; f++) {
          if (ARMS[f].id !== "control") { bucket = ARMS[f].id; break; }
        }
      }
    } catch (e) {}
    window.__overlayVariant = bucket;
    document.documentElement.setAttribute("data-overlay-variant", bucket);
    var arm = armById(bucket);
    if (!arm || !arm.ops || !arm.ops.length) return;
    applyArm(arm);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();`;
}

export function buildScriptTag(spec: ExportSpec): string {
  return `<script>\n${buildApplierSource(spec)}\n</script>`;
}

/**
 * "Copy console version" — same code, bucket FORCED to the first non-control arm (PRD §4.7's
 * instant sanity path): paste on the ORIGINAL live page, it applies immediately, no
 * localStorage read/write, no randomness — the quickest proof the variant leaves the tool.
 */
export function buildConsoleSnippet(spec: ExportSpec): string {
  const forced = spec.arms.find((a) => a.id !== "control") ?? spec.arms[0];
  return buildApplierSource(spec, { forceArmId: forced?.id });
}

export const GA4_POSTHOG_DOC_NOTE =
  "We measure nothing — read the assignment from window.__overlayVariant or the " +
  "<html data-overlay-variant> attribute and feed it into your own analytics: GA4 " +
  "(gtag('set', 'user_properties', { overlay_variant: window.__overlayVariant })) or PostHog " +
  "(posthog.register({ overlay_variant: window.__overlayVariant })) so conversions segment by " +
  "arm. Edge injection: the SAME script is injectable at the edge — a Cloudflare Worker or " +
  "Vercel Edge Middleware rewriting the response body to insert it before </body> — no code " +
  "changes, just move the paste point.";
