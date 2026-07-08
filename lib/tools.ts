/**
 * lib/tools.ts — TECH-SPEC §4 (the MVP belt: list_components/read_component/apply_op/
 * revert_op for M1; create_variant/score_variant join in M3, save_memory in M4)
 */

import { tool } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { RuntimeMsg } from "./protocol";
import { useApprovalsStore, useSchemaStore, useSettingsStore, wrapUntrusted } from "./store";
import type { Op } from "./types";

export type SendToIframe = (msg: { t: string } & Record<string, unknown>) => Promise<RuntimeMsg>;

interface Deps {
  send: SendToIframe;
}

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
      const res = await deps.send({ t: "apply-op", opId, op: fullOp });
      if (res.t !== "op-applied") return { applied: false, reason: "unexpected-response" };
      return res.ok ? { applied: true, opId, warnings: res.warnings } : { applied: false, reason: res.error };
    },
  }),

  revert_op: tool({
    description: "Undo a previously applied op.",
    inputSchema: z.object({ opId: z.string() }),
    execute: async ({ opId }) => {
      const res = await deps.send({ t: "revert-op", opId });
      return res.t === "op-reverted" ? { reverted: true } : { reverted: false };
    },
  }),
});
