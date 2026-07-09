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
 *
 * `resolveOpTarget` is the shared, PURE piece of that lookup (path + stale-or-not) — used both
 * by `reapplyOp` here and by components/ResumeOpsPanel.tsx (PR #41 review: the op list needs a
 * real, user-visible "from last session" + re-apply surface, not just this module's test hook).
 */

import type { PageNode, VariantOp } from "./types";
import { useMemoryStore, useSchemaStore, useVariantsStore } from "./store";
import type { SendToIframe } from "./tools";
import type { Op } from "./types";

export interface OpTargetResolution {
  path: string | null; // null = the saved node itself can't be resolved at all (treat as unsafe)
  stale: boolean;
}

/** Pure: saved node id -> path (via the saved snapshot) -> stale-or-not (via the resume diff). */
export function resolveOpTarget(
  vop: VariantOp,
  savedSchemaNodes: PageNode[],
  staleNodePaths: Set<string>
): OpTargetResolution {
  const savedNode = savedSchemaNodes.find((n) => n.id === vop.op.target);
  const path = savedNode?.path ?? null;
  if (!path) return { path: null, stale: true };
  return { path, stale: staleNodePaths.has(path) };
}

export interface ReapplyResult {
  applied: boolean;
  reason?: string;
}

export async function reapplyOp(variantId: string, opId: string, send: SendToIframe): Promise<ReapplyResult> {
  const variant = useVariantsStore.getState().variant(variantId);
  const vop = variant?.ops.find((o) => o.id === opId);
  if (!variant || !vop) return { applied: false, reason: "unknown op" };

  const memory = useMemoryStore.getState();
  const { path, stale } = resolveOpTarget(vop, memory.savedSchemaNodes, memory.staleNodePaths);
  if (!path) return { applied: false, reason: "target no longer resolvable" };
  if (stale) return { applied: false, reason: "stale — this section changed since last session" };

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
