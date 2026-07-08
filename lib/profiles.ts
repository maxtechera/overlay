/**
 * lib/profiles.ts — per-hostname bootstrap overrides (PRD §4.2, detection ladder rung 1)
 *
 * Bundled into lib/runtime.ts by esbuild (scripts/build-runtime.mjs) — dependency-free, same
 * as the rest of the runtime. Plain data + zero-dependency lookups only.
 *
 * These are scaffolding: known selectors for a specific hostname where the generic ladder
 * (framework fingerprint → semantic HTML → layout heuristics) under- or mis-performs. Clearly
 * labeled (`via: "profile"` on any node they produce) and deletable per site as the generic
 * ladder improves — never silently relied upon without being visible in the overlay label.
 */

export interface CollectionOverride {
  /** CSS selector for the element that directly contains the repeated card items (queried once
   *  document-wide; first match wins). */
  container: string;
  /** CSS selector for card items, scoped inside `container`. Defaults to `container`'s direct
   *  element children when omitted. */
  cardSelector?: string;
}

export interface HostProfile {
  /** CSS selector for the hero container, when the generic hero heuristic (TECH-SPEC §6) picks
   *  the wrong element on this host. */
  hero?: string;
  /** Sections whose cards live one level deeper than the generic pass looks (see the
   *  maxtechera.dev entry below for a concrete, load-bearing example of why this exists). */
  collections?: CollectionOverride[];
}

export const PROFILES: Record<string, HostProfile> = {
  "maxtechera.dev": {
    collections: [
      {
        // The "Trabajé con equipos de" logo band renders as:
        //   <section class="border-b border-border">
        //     <div>                                          <!-- ← section's ONLY direct child -->
        //       <div class="...">Trabajé con equipos de</div> <!-- label, not a heading -->
        //       <div class="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        //         <a aria-label="Oracle">…</a>  <a aria-label="Dropbox">…</a>  … ×6
        //       </div>
        //     </div>
        //   </section>
        //
        // The generic pass (runtime.ts `findRepeatedChildren`) only inspects a candidate
        // section's DIRECT children to detect repetition. Here the section's direct child is a
        // single wrapper <div> — not repeated — so the generic pass sees "1 child, no pattern"
        // and folds the whole band into a plain `section` node with no cards: the six logos
        // (and their hrefs) are invisible to the outline. Confirmed on maxtechera.dev via
        // devtools during issue #2 (2026-07-08): 0 cards detected without this override, 6 with
        // it — see e2e/m2-deep-extraction.spec.ts "profile override" spec for the live A/B.
        container: ".grid.gap-px.bg-border",
        cardSelector: "a",
      },
    ],
  },
};
