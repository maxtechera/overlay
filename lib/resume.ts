/**
 * lib/resume.ts — M4 (#4) re-apply for ops hydrated from a saved session.
 *
 * Needs `send` (an iframe round-trip), so — same split as lib/variants.ts's switchActiveVariant
 * needing a provider — it can't live in lib/store.ts.
 *
 * Why this exists: node ids are reassigned by lib/runtime.ts's extractPage counter on every
 * re-extract (lib/store.ts's schema-store comment), so a saved VariantOp's `op.target` (a node
 * id captured last session) is almost never valid against the CURRENT extraction. Re-apply must
 * re-resolve the target by PATH: saved node id -> path (via the saved schema snapshot) -> fresh
 * node id (via the current schema store) — and refuse (never guess) if that path was flagged
 * stale by the resume-time diff (lib/memory.ts's diffSchema).
 */

import { useMemoryStore, useSchemaStore, useVariantsStore } from "./store";
import type { SendToIframe } from "./tools";
import type { Op } from "./types";

export interface ReapplyResult {
  applied: boolean;
  reason?: string;
}

export async function reapplyOp(variantId: string, opId: string, send: SendToIframe): Promise<ReapplyResult> {
  const variant = useVariantsStore.getState().variant(variantId);
  const vop = variant?.ops.find((o) => o.id === opId);
  if (!variant || !vop) return { applied: false, reason: "unknown op" };

  const memory = useMemoryStore.getState();
  const savedNode = memory.savedSchemaNodes.find((n) => n.id === vop.op.target);
  const path = savedNode?.path;
  if (!path) return { applied: false, reason: "target no longer resolvable" };
  if (memory.staleNodePaths.has(path)) {
    return { applied: false, reason: "stale — this section changed since last session" };
  }

  const freshEntry = useSchemaStore.getState().outline().find((o) => o.path === path);
  if (!freshEntry) return { applied: false, reason: "target not found on the current page" };

  const remappedOp: Op = { ...vop.op, target: freshEntry.id };
  try {
    const res = await send({ t: "apply-op", opId, op: remappedOp });
    if (res.t !== "op-applied") return { applied: false, reason: "unexpected-response" };
    if (!res.ok) return { applied: false, reason: res.error };
    useVariantsStore.getState().markLive(opId);
    return { applied: true };
  } catch (e) {
    return { applied: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
