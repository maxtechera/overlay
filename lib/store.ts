/**
 * lib/store.ts — zustand stores (TECH-SPEC §9)
 *
 * M1b (#13) implements: session (minimal url/goal slice — M2b/#14 extends with
 * brief/context/status), settings, schema, chat, approvals. Variant/experiment stores
 * join in M3/M4.
 */

import { create } from "zustand";
import { nanoid } from "nanoid";
import type { ModelMessage } from "ai";
import type { ComScore, Op, PageNode } from "./types";

// ── session (minimal M1 slice) ──────────────────────────────────────────────────

interface SessionState {
  url: string;
  goal: string;
  setUrl: (url: string) => void;
  setGoal: (goal: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  url: "",
  goal: "",
  setUrl: (url) => set({ url }),
  setGoal: (goal) => set({ goal }),
}));

// ── settings ─────────────────────────────────────────────────────────────────────

export type ModelId = "claude-sonnet-4-6" | "claude-haiku-4-5" | "claude-opus-4-8";

interface SettingsState {
  model: ModelId;
  thinking: boolean;
  approvalMode: "ask" | "auto";
  setModel: (model: ModelId) => void;
  setThinking: (thinking: boolean) => void;
  setApprovalMode: (mode: "ask" | "auto") => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  model: "claude-sonnet-4-6",
  // Default on: the settings-bar toggle (M2b/#14) will let a user flip this; until then
  // reasoning renders by default so the transcript's collapsible reasoning block is a real,
  // exercised path rather than dead code (PRD §4.3 "you watch it think, like Claude Code").
  thinking: true,
  approvalMode: "ask",
  setModel: (model) => set({ model }),
  setThinking: (thinking) => set({ thinking }),
  setApprovalMode: (approvalMode) => set({ approvalMode }),
}));

// ── schema (outline/node lookups for list_components/read_component — TECH-SPEC §4) ──

export interface ComponentOutlineEntry {
  id: string;
  path: string;
  type: PageNode["type"];
  preview: string; // wrapped in <<<PAGE …>>> markers — untrusted page data
}

interface SchemaState {
  nodes: Record<string, PageNode>;
  order: string[];
  setNodes: (nodes: PageNode[]) => void;
  outline: () => ComponentOutlineEntry[];
  node: (id: string) => PageNode | undefined;
}

const PAGE_OPEN = "<<<PAGE";
const PAGE_CLOSE = "PAGE>>>";

/** Wrap page-derived text in the untrusted-data markers (TECH-SPEC §6, §8). */
export function wrapUntrusted(text: string): string {
  return `${PAGE_OPEN} ${text} ${PAGE_CLOSE}`;
}

function previewOf(node: PageNode): string {
  const parts = Object.values(node.slots)
    .map((s) => s.text)
    .filter((t): t is string => Boolean(t && t.trim()));
  const joined = parts.join(" · ").slice(0, 100);
  return joined || "(no text)";
}

export const useSchemaStore = create<SchemaState>((set, get) => ({
  nodes: {},
  order: [],
  setNodes: (nodes) => {
    const map: Record<string, PageNode> = {};
    const order: string[] = [];
    for (const n of nodes) {
      map[n.id] = n;
      order.push(n.id);
    }
    set({ nodes: map, order });
  },
  outline: () =>
    get().order.map((id) => {
      const n = get().nodes[id];
      return { id: n.id, path: n.path, type: n.type, preview: wrapUntrusted(previewOf(n)) };
    }),
  node: (id) => get().nodes[id],
}));

// ── approvals (apply_op's human-in-the-loop gate) ───────────────────────────────

interface ApprovalsState {
  pending: Map<string, (approved: boolean) => void>;
  request: (key: string, op: Op) => Promise<boolean>;
  resolve: (key: string, approved: boolean) => void;
}

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  pending: new Map(),
  request: (key) =>
    new Promise<boolean>((resolve) => {
      get().pending.set(key, resolve);
    }),
  resolve: (key, approved) => {
    const fn = get().pending.get(key);
    if (fn) {
      fn(approved);
      get().pending.delete(key);
    }
  },
}));

// ── chat ─────────────────────────────────────────────────────────────────────────

export type ToolStatus = "running" | "done" | "error";
export type ProposalStatus = "pending" | "approved" | "rejected";

export type ChatBlock =
  | { kind: "text"; id: string; role: "user" | "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      name: string;
      input: unknown;
      output?: unknown;
      status: ToolStatus;
      startedAt: number;
      durationMs?: number;
    }
  | {
      kind: "proposal";
      id: string;
      toolCallId: string;
      opId?: string;
      op: Op;
      before: Record<string, { text?: string; href?: string; src?: string; alt?: string }>;
      score?: ComScore;
      status: ProposalStatus;
      reason?: string;
      warnings?: string[];
    }
  | { kind: "reasoning"; id: string; text: string; streaming: boolean }
  | { kind: "error"; id: string; text: string };

export interface Telemetry {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  ms: number;
}

interface ChatState {
  blocks: ChatBlock[];
  messages: ModelMessage[];
  streaming: boolean;
  telemetry: Telemetry[];
  // internal: which block is currently receiving deltas
  activeTextId: string | null;
  activeReasoningId: string | null;

  setStreaming: (streaming: boolean) => void;
  pushUser: (text: string) => void;
  appendText: (delta: string) => void;
  appendReasoning: (delta: string) => void;
  openTool: (toolCallId: string, name: string, input: unknown) => void;
  closeTool: (toolCallId: string, output: unknown) => void;
  openProposal: (toolCallId: string, op: Op) => void;
  closeProposal: (toolCallId: string, output: unknown) => void;
  setProposalStatus: (toolCallId: string, status: ProposalStatus) => void;
  setProposalScore: (toolCallId: string, score: ComScore) => void;
  pushError: (text: string) => void;
  commitTurn: (userMsg: ModelMessage, responseMsgs: ModelMessage[], telemetry: Telemetry) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  blocks: [],
  messages: [],
  streaming: false,
  telemetry: [],
  activeTextId: null,
  activeReasoningId: null,

  setStreaming: (streaming) => set({ streaming }),

  pushUser: (text) =>
    set((s) => ({
      blocks: [...s.blocks, { kind: "text", id: nanoid(), role: "user", text }],
      activeTextId: null,
      activeReasoningId: null,
    })),

  appendText: (delta) => {
    const s = get();
    const last = s.blocks.at(-1);
    if (s.activeTextId && last?.kind === "text" && last.id === s.activeTextId) {
      const activeId = last.id;
      set({
        blocks: s.blocks.map((b) => (b.kind === "text" && b.id === activeId ? { ...b, text: b.text + delta } : b)),
      });
      return;
    }
    const id = nanoid();
    set({
      blocks: [...s.blocks, { kind: "text", id, role: "assistant", text: delta }],
      activeTextId: id,
      activeReasoningId: null,
    });
  },

  appendReasoning: (delta) => {
    const s = get();
    const last = s.blocks.at(-1);
    if (s.activeReasoningId && last?.kind === "reasoning" && last.id === s.activeReasoningId) {
      const activeId = last.id;
      set({
        blocks: s.blocks.map((b) => (b.kind === "reasoning" && b.id === activeId ? { ...b, text: b.text + delta } : b)),
      });
      return;
    }
    const id = nanoid();
    set({
      blocks: [...s.blocks, { kind: "reasoning", id, text: delta, streaming: true }],
      activeReasoningId: id,
      activeTextId: null,
    });
  },

  openTool: (toolCallId, name, input) =>
    set((s) => ({
      blocks: [
        ...s.blocks,
        {
          kind: "tool",
          id: nanoid(),
          toolCallId,
          name,
          input,
          status: "running",
          startedAt: performance.now(),
        },
      ],
      activeTextId: null,
      activeReasoningId: null,
    })),

  closeTool: (toolCallId, output) =>
    set((s) => ({
      blocks: s.blocks.map((b) =>
        b.kind === "tool" && b.toolCallId === toolCallId
          ? {
              ...b,
              output,
              status: isErrorOutput(output) ? "error" : "done",
              durationMs: performance.now() - b.startedAt,
            }
          : b
      ),
    })),

  openProposal: (toolCallId, op) => {
    const before: Record<string, { text?: string; href?: string; src?: string; alt?: string }> = {};
    const node = useSchemaStore.getState().node(op.target);
    if (node) {
      for (const key of Object.keys(op.slots)) {
        const slot = node.slots[key];
        if (slot) before[key] = { text: slot.text, href: slot.href, src: slot.src, alt: slot.alt };
      }
    }
    set((s) => ({
      blocks: [
        ...s.blocks,
        { kind: "proposal", id: nanoid(), toolCallId, op, before, status: "pending" },
      ],
      activeTextId: null,
      activeReasoningId: null,
    }));
  },

  closeProposal: (toolCallId, output) => {
    const o = output as { applied?: boolean; opId?: string; reason?: string; warnings?: string[] };
    set((s) => ({
      blocks: s.blocks.map((b) =>
        b.kind === "proposal" && b.toolCallId === toolCallId
          ? {
              ...b,
              status: o?.applied ? "approved" : "rejected",
              opId: o?.opId,
              reason: o?.reason,
              warnings: o?.warnings,
            }
          : b
      ),
    }));
  },

  setProposalStatus: (toolCallId, status) =>
    set((s) => ({
      blocks: s.blocks.map((b) => (b.kind === "proposal" && b.toolCallId === toolCallId ? { ...b, status } : b)),
    })),

  setProposalScore: (toolCallId, score) =>
    set((s) => ({
      blocks: s.blocks.map((b) => (b.kind === "proposal" && b.toolCallId === toolCallId ? { ...b, score } : b)),
    })),

  pushError: (text) =>
    set((s) => ({
      blocks: [...s.blocks, { kind: "error", id: nanoid(), text }],
      activeTextId: null,
      activeReasoningId: null,
    })),

  commitTurn: (userMsg, responseMsgs, telemetry) =>
    set((s) => ({
      messages: [...s.messages, userMsg, ...responseMsgs],
      telemetry: [...s.telemetry, telemetry],
      activeTextId: null,
      activeReasoningId: null,
    })),
}));

function isErrorOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "error" in output &&
    typeof (output as { error?: unknown }).error === "string"
  );
}
