/**
 * lib/tools.ts — TECH-SPEC §4 (the MVP belt: list_components/read_component/apply_op/
 * revert_op for M1; create_variant/score_variant join in M3, save_memory in M4)
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { scoreVariant, type SlotSnapshot } from "./com";
import type { RuntimeMsg } from "./protocol";
import {
  useApprovalsStore,
  useExperimentsStore,
  usePreviewStore,
  useSchemaStore,
  useSessionStore,
  useSettingsStore,
  useVariantsStore,
  wrapUntrusted,
} from "./store";
import { captureThumbnail } from "./thumbnail";
import type { Op, VariantOp } from "./types";
import { switchActiveVariant } from "./variants";

export type SendToIframe = (msg: { t: string } & Record<string, unknown>) => Promise<RuntimeMsg>;

interface Deps {
  send: SendToIframe;
}

// Same proxy pattern as lib/agent.ts / lib/brief.ts — the key never reaches the browser
// (TECH-SPEC §1). score_variant wires com.ts's scoreVariant through this provider; com.ts
// itself stays pure (isolation rule — imports nothing from agent.ts or stores).
const anthropicProxy = createAnthropic({ apiKey: "proxied", baseURL: "/api/anthropic/v1" });

/** Wrap a node's text-bearing slots in the untrusted-data markers before handing to the model. */
function wrapNodeForModel<T extends { slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }> }>(
  node: T
) {
  const slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }> = {};
  for (const [k, v] of Object.entries(node.slots)) {
    slots[k] = { ...v, text: v.text ? wrapUntrusted(v.text) : v.text };
  }
  return { ...node, slots };
}

export const makeTools = (deps: Deps) => ({
  list_components: tool({
    description: "Outline of every identified component: id, path, type, text preview.",
    inputSchema: z.object({}),
    execute: async () => useSchemaStore.getState().outline(),
  }),

  read_component: tool({
    description: "Full detail of one component: slots, classes, rect.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const node = useSchemaStore.getState().node(id);
      return node ? wrapNodeForModel(node) : { error: "unknown id" };
    },
  }),

  apply_op: tool({
    description: "Propose a content change. Requires human approval; may be rejected.",
    inputSchema: z.object({
      target: z.string(),
      slots: z.record(
        z.object({
          text: z.string().optional(),
          href: z.string().optional(),
          src: z.string().optional(),
          alt: z.string().optional(),
        })
      ),
      rationale: z.string(),
    }),
    execute: async (op, { toolCallId }) => {
      const fullOp: Op = { op: "update-content", target: op.target, slots: op.slots, rationale: op.rationale };
      const settings = useSettingsStore.getState();
      const approved =
        settings.approvalMode === "auto" ? true : await useApprovalsStore.getState().request(toolCallId, fullOp);
      if (!approved) return { applied: false, reason: "rejected by user" }; // resolve, NEVER throw

      const opId = nanoid();
      // deps.send rejects on the IframeHost 30s timeout or an "iframe not ready" send —
      // convert to a string result; a tool must NEVER throw across the postMessage boundary
      // (CLAUDE.md hard rule / TECH-SPEC §3), else the loop wedges the ProposalCard.
      try {
        const res = await deps.send({ t: "apply-op", opId, op: fullOp });
        if (res.t !== "op-applied") return { applied: false, reason: "unexpected-response" };
        if (!res.ok) return { applied: false, reason: res.error };

        // M3 (#3): whatever variant is currently active (not "control") owns this op — record
        // it so switching tabs away and back can revert-then-replay it exactly (TECH-SPEC §9).
        // Direct edits made while activeId === "control" (pre-M3 behavior) are unchanged —
        // still revertible via revert_op, just not attributed to any named variant.
        const activeId = useVariantsStore.getState().activeId;
        if (activeId !== "control") {
          const vop: VariantOp = { id: opId, source: "agent", op: fullOp, status: "applied" };
          useVariantsStore.getState().recordOp(activeId, vop);
        }
        return { applied: true, opId, warnings: res.warnings };
      } catch (e) {
        return { applied: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  }),

  revert_op: tool({
    description: "Undo a previously applied op.",
    inputSchema: z.object({ opId: z.string() }),
    execute: async ({ opId }) => {
      try {
        const res = await deps.send({ t: "revert-op", opId });
        if (res.t !== "op-reverted") return { reverted: false, error: "unexpected-response" };
        const activeId = useVariantsStore.getState().activeId;
        if (activeId !== "control") useVariantsStore.getState().removeOp(activeId, opId);
        return { reverted: true };
      } catch (e) {
        return { reverted: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  }),

  // Issue #28 (item 3), raised 4→5 by issue #35 (item 1): create_variant below enforces a hard
  // cap of 5 arms per experiment (or 5 ad-hoc variants when no experimentId is given) — a
  // demo-polish guard against unbounded variant sessions, and the carousel's "5 per module"
  // ceiling (components/VariantGallery.tsx). App-side, independent of whatever the prompt steers
  // toward (lib/prompts.ts also asks for fewer/smaller variants, but this is the enforcement
  // backstop). Ignoring the 6th call is a normal tool result, never a throw.
  create_variant: tool({
    description:
      "Save a recommendation as a new named variant and make it active. Use one variant per distinct angle/hypothesis — call this again (with a new name) before starting a different angle. Optionally aim it at a brief segment, or tie it to an Experiment Plan card's id as one of that experiment's arms. Capped at 5 variants per experiment (or 5 ad-hoc variants when no experimentId is given) — a 6th call for the same scope is ignored, not created.",
    inputSchema: z.object({
      name: z.string().max(60),
      goal: z.string().optional(),
      segment: z.string().optional(),
      experimentId: z.string().optional(),
    }),
    execute: async ({ name, goal, segment, experimentId }) => {
      // Scope = the experiment this arm belongs to, or "ad-hoc" (no experimentId) as its own
      // group — either way, capped at 5 (issue #35's "≤5 variants" clamp).
      const MAX_ARMS_PER_SCOPE = 5;
      const existingInScope = useVariantsStore
        .getState()
        .list.filter((v) => (experimentId ? v.experimentId === experimentId : !v.experimentId)).length;
      if (existingInScope >= MAX_ARMS_PER_SCOPE) {
        return { created: false, reason: `max ${MAX_ARMS_PER_SCOPE} arms per experiment` };
      }

      // Every new variant starts from a clean control — revert whatever was previously active
      // before creating+activating the new (empty) one (TECH-SPEC §9's switching semantics
      // apply here too: create_variant is itself a switch, from wherever we were to "control",
      // followed by activating the fresh variant which then replays nothing — it has 0 ops).
      try {
        await switchActiveVariant("control", deps.send);
      } catch {
        // best-effort — do not let a stale revert block variant creation
      }
      const variant = useVariantsStore.getState().create(name, goal, segment, experimentId);
      useVariantsStore.getState().setActiveId(variant.id);
      return { created: true, id: variant.id, name: variant.name, active: true, experimentId: variant.experimentId };
    },
  }),

  score_variant: tool({
    description: "Independent conversion rating of the ACTIVE variant vs control.",
    inputSchema: z.object({}),
    execute: async () => {
      const variantsState = useVariantsStore.getState();
      if (variantsState.activeId === "control") {
        return { error: "no active variant — call create_variant first" };
      }
      const active = variantsState.variant(variantsState.activeId);
      if (!active) return { error: "active variant not found" };

      const applied = active.ops.filter((v) => v.status === "applied");
      if (applied.length === 0) {
        return { error: "active variant has no applied changes yet — apply_op first" };
      }

      const schema = useSchemaStore.getState();
      const session = useSessionStore.getState();

      // Group applied ops by target node so a variant that touches the same node's slots
      // across multiple ops still scores ONE before/after snapshot per node (SlotSnapshot =
      // one entry per CHANGED node, TECH-SPEC §7).
      const byTarget = new Map<string, VariantOp[]>();
      for (const vop of applied) {
        const arr = byTarget.get(vop.op.target) ?? [];
        arr.push(vop);
        byTarget.set(vop.op.target, arr);
      }

      const control: SlotSnapshot[] = [];
      const variantSnap: SlotSnapshot[] = [];
      for (const [targetId, vops] of byTarget) {
        const node = schema.node(targetId);
        if (!node) continue;
        const before: Record<string, string> = {};
        const after: Record<string, string> = {};
        for (const vop of vops) {
          for (const [slotKey, slotVal] of Object.entries(vop.op.slots)) {
            if (slotVal.text === undefined) continue; // href/src/alt-only changes aren't scored
            before[slotKey] = node.slots[slotKey]?.text ?? "";
            after[slotKey] = slotVal.text;
          }
        }
        if (Object.keys(after).length > 0) {
          control.push({ path: node.path, slots: before });
          variantSnap.push({ path: node.path, slots: after });
        }
      }

      if (variantSnap.length === 0) {
        return { error: "active variant has no text changes to score (href/src/alt-only ops aren't scored)" };
      }

      const score = await scoreVariant(
        { brief: session.brief, goal: active.goal || session.goal, control, variant: variantSnap },
        anthropicProxy
      );
      useVariantsStore.getState().setScore(active.id, score);

      // Best-effort thumbnail — capture NOW, while this variant's ops are still live in the
      // iframe ("on first score of a variant", TECH-SPEC §9). Never blocks/throws; a styled
      // fallback card renders when this is absent (components/VariantGallery.tsx).
      try {
        const dataUrl = await captureThumbnail(usePreviewStore.getState().iframeEl);
        if (dataUrl) useVariantsStore.getState().setThumbnail(active.id, dataUrl);
      } catch {
        // fallback card handles this
      }

      // Status flow (PRD §4.5): once every arm of the owning experiment has a score, the
      // experiment is "ready" (a real bandit reallocates with live traffic later, M9/M10).
      if (active.experimentId) {
        const exp = useExperimentsStore.getState().list.find((e) => e.id === active.experimentId);
        if (exp && exp.status !== "ready") {
          const arms = exp.armIds.map((id) => useVariantsStore.getState().variant(id));
          const allScored = arms.length > 0 && arms.every((a) => a?.score !== undefined);
          if (allScored) useExperimentsStore.getState().setStatus(exp.id, "ready");
        }
      }

      return score;
    },
  }),
});
