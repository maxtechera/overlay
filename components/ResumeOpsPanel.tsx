"use client";

/**
 * components/ResumeOpsPanel.tsx — M4 (#4), PR #41 review fix (BLOCKER 2).
 *
 * TECH-SPEC §11: "the op list shows 'from last session' with a re-apply action... valid only
 * for non-stale targets." This is the real, user-visible surface for that — components/
 * VariantGallery.tsx is a parallel lane's file (out of this issue's boundary), so this is a
 * small, additive sibling panel rather than a change to it. Self-hides once nothing is
 * hydrated-from-last-session (hydratedOpIds empties out as each op gets explicitly re-applied
 * or the user starts a fresh session).
 */

import { useEffect, useState } from "react";
import { resolveOpTarget } from "@/lib/resume";
import { useMemoryStore, useVariantsStore } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";
import { reapplyOp } from "@/lib/resume";

export function ResumeOpsPanel({ send }: { send: SendToIframe }) {
  const list = useVariantsStore((s) => s.list);
  const hydratedOpIds = useVariantsStore((s) => s.hydratedOpIds);
  const staleNodePaths = useMemoryStore((s) => s.staleNodePaths);
  const savedSchemaNodes = useMemoryStore((s) => s.savedSchemaNodes);
  const [pendingOpId, setPendingOpId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { applied: boolean; reason?: string }>>({});

  // A new session (fresh URL submit) resets the variants store to an empty list BEFORE
  // hydrate() repopulates it — clear any leftover local confirmation state from a PREVIOUS
  // site's session at that same reset point, so a stale "re-applied" badge never survives
  // into an unrelated resumed session.
  useEffect(() => {
    if (list.length === 0) setResults({});
  }, [list]);

  // Bug found in review (PR #41 verification): reapplyOp's success path calls markLive, which
  // removes the op from hydratedOpIds — but hydratedOpIds was ALSO this component's sole
  // membership gate for showing a row, so a successful re-apply made its own row vanish before
  // the "re-applied" confirmation could ever render. A row now stays visible if it's either
  // still hydrated (pending) OR was successfully re-applied THIS session (tracked locally).
  const relevantOpIds = new Set([
    ...hydratedOpIds,
    ...Object.entries(results)
      .filter(([, r]) => r.applied)
      .map(([id]) => id),
  ]);
  if (relevantOpIds.size === 0) return null;

  const rows = list.flatMap((v) =>
    v.ops
      .filter((o) => relevantOpIds.has(o.id))
      .map((o) => ({ variantId: v.id, variantName: v.name, op: o, ...resolveOpTarget(o, savedSchemaNodes, staleNodePaths) }))
  );
  if (rows.length === 0) return null;

  const handleReapply = async (variantId: string, opId: string) => {
    setPendingOpId(opId);
    const res = await reapplyOp(variantId, opId, send);
    setResults((r) => ({ ...r, [opId]: res }));
    setPendingOpId(null);
  };

  return (
    <div className="msg agent" data-testid="resume-ops-panel">
      <div className="who">from last session</div>
      <div className="body" style={{ fontSize: 12 }}>
        {rows.map(({ variantId, variantName, op, stale, path }) => {
          const result = results[op.id];
          return (
            <div
              data-op-id={op.id}
              data-stale={stale}
              data-testid="resume-op-row"
              key={op.id}
              style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, padding: "3px 0" }}
            >
              <span className="mono" style={{ color: "var(--faint)" }}>
                {variantName}
              </span>
              <span>{op.op.rationale}</span>
              {stale ? (
                <span data-testid="resume-op-stale" style={{ color: "#e07a1f" }}>
                  stale — {path ?? "target"} changed since last session
                </span>
              ) : result?.applied ? (
                <span data-testid="resume-op-reapplied" style={{ color: "#2e9e5b" }}>
                  re-applied
                </span>
              ) : (
                <button
                  data-testid="resume-op-reapply"
                  disabled={pendingOpId === op.id}
                  onClick={() => handleReapply(variantId, op.id)}
                  type="button"
                >
                  {pendingOpId === op.id ? "applying…" : "Re-apply"}
                </button>
              )}
              {result && !result.applied && !stale && (
                <span data-testid="resume-op-error" style={{ color: "#c0392b" }}>
                  {result.reason}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
