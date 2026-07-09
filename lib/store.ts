/**
 * lib/store.ts — zustand stores (TECH-SPEC §9)
 *
 * M1b (#13) implemented: session (minimal url/goal slice), settings, schema, chat, approvals.
 * M2b (#14) extends session with status/error/brief/context and adds experiments + composer.
 * Variant store joins in M3, memory persistence in M4.
 */

import { create } from "zustand";
import { nanoid } from "nanoid";
import type { ModelMessage } from "ai";
import type { ComScore, Experiment, Op, PageBrief, PageNode, Variant, VariantOp } from "./types";

// ── session (TECH-SPEC §9) ──────────────────────────────────────────────────────

function contextStorageKey(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    return `overlay:context:${hostname}`;
  } catch {
    return null;
  }
}

/** Best-effort localStorage read — never throws (SSR / privacy-mode safety). */
function loadContext(url: string): string {
  if (typeof window === "undefined") return "";
  const key = contextStorageKey(url);
  if (!key) return "";
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function saveContext(url: string, context: string): void {
  if (typeof window === "undefined") return;
  const key = contextStorageKey(url);
  if (!key) return;
  try {
    window.localStorage.setItem(key, context);
  } catch {
    // ignore (private mode / quota) — context still lives in memory for the session
  }
}

interface SessionState {
  url: string;
  status: "idle" | "ingesting" | "extracting" | "ready" | "error";
  error?: string;
  brief: PageBrief | null;
  goal: string;
  context: string; // user-authored project context — localStorage-persisted until M4
  setUrl: (url: string) => void;
  setStatus: (status: SessionState["status"], error?: string) => void;
  setGoal: (goal: string) => void;
  setBrief: (brief: PageBrief | null) => void;
  patchBrief: (patch: Partial<PageBrief>) => void;
  setContext: (context: string) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  url: "",
  status: "idle",
  error: undefined,
  brief: null,
  goal: "",
  context: "",
  setUrl: (url) => set({ url, context: loadContext(url) }),
  setStatus: (status, error) => set({ status, error }),
  setGoal: (goal) => set({ goal }),
  setBrief: (brief) => set({ brief }),
  patchBrief: (patch) => set((s) => ({ brief: s.brief ? { ...s.brief, ...patch } : (patch as PageBrief) })),
  setContext: (context) => {
    set({ context });
    saveContext(get().url, context);
  },
}));

// ── experiments (Experiment Plan — TECH-SPEC §9) ────────────────────────────────

interface ExperimentsState {
  list: Experiment[];
  setList: (list: Experiment[]) => void;
  setStatus: (id: string, status: Experiment["status"]) => void;
  // M3 (#3): "Build arms" (create_variant with an experimentId) links the new variant onto
  // its owning experiment's armIds and — the FIRST time an experiment gets an arm — flips
  // proposed -> building (PRD §4.5's status flow). score_variant flips building -> ready once
  // every arm is scored (lib/tools.ts).
  addArm: (experimentId: string, variantId: string) => void;
}

export const useExperimentsStore = create<ExperimentsState>((set) => ({
  list: [],
  setList: (list) => set({ list }),
  setStatus: (id, status) =>
    set((s) => ({ list: s.list.map((e) => (e.id === id ? { ...e, status } : e)) })),
  addArm: (experimentId, variantId) =>
    set((s) => ({
      list: s.list.map((e) =>
        e.id === experimentId
          ? {
              ...e,
              armIds: [...e.armIds, variantId],
              status: e.status === "proposed" ? "building" : e.status,
            }
          : e
      ),
    })),
}));

// ── variants (Control · A · B · … — TECH-SPEC §9) ───────────────────────────────
//
// The app holds Variant[] + activeId ("control" | variant id). `list` never has a "control"
// entry — control IS the untouched page. Ops always record prevSlots vs CONTROL (lib/runtime.ts
// applySlots), so switching tabs = revert the outgoing variant's ops (LIFO) then replay the
// incoming variant's ops in order (lib/variants.ts's switchActiveVariant, which needs `send`
// and so can't live here — same split as lib/brief.ts needing a provider).

interface VariantsState {
  list: Variant[];
  activeId: string; // "control" | variant id
  thumbnails: Record<string, string>; // variantId -> data URL (best-effort html2canvas, §9)
  create: (name: string, goal?: string, segment?: string, experimentId?: string) => Variant;
  variant: (id: string) => Variant | undefined;
  setActiveId: (id: string) => void;
  recordOp: (variantId: string, vop: VariantOp) => void;
  removeOp: (variantId: string, opId: string) => void;
  setScore: (variantId: string, score: ComScore) => void;
  setThumbnail: (variantId: string, dataUrl: string) => void;
  reset: () => void;
}

export const useVariantsStore = create<VariantsState>((set, get) => ({
  list: [],
  activeId: "control",
  thumbnails: {},
  create: (name, goal, segment, experimentId) => {
    const variant: Variant = {
      id: nanoid(),
      name,
      goal: goal ?? useSessionStore.getState().goal,
      segment,
      experimentId,
      ops: [],
    };
    set((s) => ({ list: [...s.list, variant] }));
    if (experimentId) useExperimentsStore.getState().addArm(experimentId, variant.id);
    return variant;
  },
  variant: (id) => get().list.find((v) => v.id === id),
  setActiveId: (id) => set({ activeId: id }),
  recordOp: (variantId, vop) =>
    set((s) => ({
      list: s.list.map((v) => (v.id === variantId ? { ...v, ops: [...v.ops, vop] } : v)),
    })),
  removeOp: (variantId, opId) =>
    set((s) => ({
      list: s.list.map((v) => (v.id === variantId ? { ...v, ops: v.ops.filter((o) => o.id !== opId) } : v)),
    })),
  setScore: (variantId, score) =>
    set((s) => ({ list: s.list.map((v) => (v.id === variantId ? { ...v, score } : v)) })),
  setThumbnail: (variantId, dataUrl) =>
    set((s) => ({ thumbnails: { ...s.thumbnails, [variantId]: dataUrl } })),
  reset: () => set({ list: [], activeId: "control", thumbnails: {} }),
}));

// ── composer (shared state so ExperimentPlan/ComponentCard/preview clicks can drive the
// chat input from outside ChatPane — TECH-SPEC §10's two-way click↔chat wiring) ───────

export interface ReferenceChip {
  nodeId: string;
  path: string;
  // Present when the chip came from a slot-level overlay box click (issue #32) rather than a
  // whole-node preview click (M2b's original "selected" wiring) — lets the composer render a
  // richer "selected: <slot> — <preview>" chip and carry the slot text as fenced context.
  slot?: string;
  preview?: string;
}

interface ComposerState {
  text: string;
  referenceChip: ReferenceChip | null;
  setText: (text: string) => void;
  setReferenceChip: (chip: ReferenceChip | null) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  text: "",
  referenceChip: null,
  setText: (text) => set({ text }),
  setReferenceChip: (referenceChip) => set({ referenceChip }),
}));

// ── preview (parent-side handle to the live iframe, for ComponentCard highlight+scroll —
// reaching into the SAME-ORIGIN iframe document from the parent, same pattern as the M3
// html2canvas note in TECH-SPEC §9; does NOT touch lib/runtime.ts) ─────────────────────

interface PreviewState {
  iframeEl: HTMLIFrameElement | null;
  setIframeEl: (el: HTMLIFrameElement | null) => void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  iframeEl: null,
  setIframeEl: (iframeEl) => set({ iframeEl }),
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
  seo: PageBrief["seo"] | null;
  a11yAudit: PageBrief["a11yAudit"];
  setNodes: (nodes: PageNode[]) => void;
  // Real extraction path (page.tsx): nodes + the deterministic SEO/ADA rollup that rides
  // alongside them (TECH-SPEC §6). setNodes stays payload-only — the m1b injection-fixture
  // spec and other test hooks seed nodes without an extraction round-trip.
  setExtraction: (nodes: PageNode[], seo: PageBrief["seo"], a11yAudit: PageBrief["a11yAudit"]) => void;
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
  seo: null,
  a11yAudit: [],
  setNodes: (nodes) => {
    const map: Record<string, PageNode> = {};
    const order: string[] = [];
    for (const n of nodes) {
      map[n.id] = n;
      order.push(n.id);
    }
    set({ nodes: map, order });
  },
  setExtraction: (nodes, seo, a11yAudit) => {
    const map: Record<string, PageNode> = {};
    const order: string[] = [];
    for (const n of nodes) {
      map[n.id] = n;
      order.push(n.id);
    }
    set({ nodes: map, order, seo, a11yAudit });
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
  | { kind: "brief"; id: string } // no payload — BriefArtifact reads session.brief live
  | { kind: "plan"; id: string } // no payload — ExperimentPlanBlock reads experiments.list live
  | { kind: "gallery"; id: string } // no payload — VariantGalleryBlock reads variants.list live
  | { kind: "export"; id: string } // no payload — ExportBlock reads variants/experiments live (M5/#10)
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
  pushBrief: () => void;
  pushPlan: () => void;
  pushGallery: () => void;
  pushExport: () => void;
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

  // Pushed once, immediately, when generation KICKS OFF (not when it completes) — so the
  // artifact appears with zero dead-air and fills in as session.brief/experiments.list update
  // (TECH-SPEC §10 latency choreography). No-ops if already present (a resumed/re-run session
  // shouldn't duplicate the block).
  pushBrief: () =>
    set((s) =>
      s.blocks.some((b) => b.kind === "brief")
        ? s
        : { blocks: [...s.blocks, { kind: "brief", id: nanoid() }], activeTextId: null, activeReasoningId: null }
    ),
  pushPlan: () =>
    set((s) =>
      s.blocks.some((b) => b.kind === "plan")
        ? s
        : { blocks: [...s.blocks, { kind: "plan", id: nanoid() }], activeTextId: null, activeReasoningId: null }
    ),

  // Pushed after any turn in which create_variant was called (lib/agent.ts) — and callable on
  // request. Unlike brief/plan, NOT deduped session-wide (variant activity can recur many
  // times per session); only an immediate consecutive duplicate is skipped so one turn that
  // calls create_variant several times doesn't spam several identical blocks in a row.
  pushGallery: () =>
    set((s) =>
      s.blocks.at(-1)?.kind === "gallery"
        ? s
        : { blocks: [...s.blocks, { kind: "gallery", id: nanoid() }], activeTextId: null, activeReasoningId: null }
    ),

  // Pushed by the Export button on the Variant Gallery (M5/#10). Not session-wide deduped
  // (gallery pattern) — only an immediate consecutive duplicate is skipped, same reasoning as
  // pushGallery: a user may legitimately re-open Export later in the same session.
  pushExport: () =>
    set((s) =>
      s.blocks.at(-1)?.kind === "export"
        ? s
        : { blocks: [...s.blocks, { kind: "export", id: nanoid() }], activeTextId: null, activeReasoningId: null }
    ),

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
