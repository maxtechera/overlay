/**
 * lib/variants.ts — TECH-SPEC §9 variant-switching orchestration + the COM-prior suggested
 * allocation formula (PRD §4.5). Needs `send` (an iframe round-trip), so it can't live in
 * lib/store.ts itself — the same split as lib/brief.ts needing a provider for its own calls.
 *
 * Used by: create_variant (lib/tools.ts, "start this new arm from a clean control"),
 * VariantTabs and VariantGallery's click-to-switch (both call switchActiveVariant directly).
 */

import { useVariantsStore } from "./store";
import type { SendToIframe } from "./tools";
import type { Variant } from "./types";

/**
 * "switching = revert-to-control + replay that variant's ops" (TECH-SPEC §9): revert the
 * OUTGOING variant's applied ops in reverse order (LIFO — safe even when two ops touch
 * overlapping targets), then replay the INCOMING variant's ops in original order. No-op if
 * `targetId` is already active. Best-effort per op: a stale/refind-failed op must never wedge
 * the whole switch.
 */
export async function switchActiveVariant(targetId: string, send: SendToIframe): Promise<void> {
  const store = useVariantsStore.getState();
  const current = store.activeId;
  if (current === targetId) return;

  if (current !== "control") {
    const outgoing = store.variant(current);
    if (outgoing) {
      for (const vop of [...outgoing.ops].reverse()) {
        if (vop.status !== "applied") continue;
        try {
          await send({ t: "revert-op", opId: vop.id });
        } catch {
          // best-effort — do not let one stale op block the rest of the switch
        }
      }
    }
  }

  useVariantsStore.getState().setActiveId(targetId);

  if (targetId !== "control") {
    const incoming = useVariantsStore.getState().variant(targetId);
    if (incoming) {
      for (const vop of incoming.ops) {
        if (vop.status !== "applied") continue;
        try {
          await send({ t: "apply-op", opId: vop.id, op: vop.op });
        } catch {
          // best-effort
        }
      }
    }
  }
}

/**
 * COM-prior suggested traffic allocation (TECH-SPEC §9 / PRD §4.5): control fixed at 25%, the
 * remaining 75% split PROPORTIONAL to each arm's COM delta. A losing arm still gets a small
 * floor share (never literally zero) — this is a PRIOR to seed a bandit, not a claim that a
 * worse-scoring arm gets no traffic. Unscored arms (score undefined) get the floor only, same
 * as a clamped-negative delta. Pure/deterministic — no store reads, easy to unit-test directly.
 */
export function suggestedAllocation(arms: Variant[]): Record<string, number> {
  const CONTROL_SHARE = 0.25;
  const FLOOR = 0.01;
  if (arms.length === 0) return { control: 1 };

  const weights = arms.map((a) => Math.max(a.score?.delta ?? 0, 0) + FLOOR);
  const total = weights.reduce((a, b) => a + b, 0);

  const alloc: Record<string, number> = { control: CONTROL_SHARE };
  arms.forEach((a, i) => {
    alloc[a.id] = (1 - CONTROL_SHARE) * (weights[i] / total);
  });
  return alloc;
}
