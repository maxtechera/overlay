/**
 * lib/protocol.ts — iframe postMessage protocol + IframeHost bridge
 * TECH-SPEC §3
 *
 * Every message carries a requestId (nanoid). Unsolicited messages (selected, op-wiped)
 * have no requestId — they are dispatched directly to callbacks.
 */

import type { PageNode } from "./types";

// ── Message types ──────────────────────────────────────────────────────────────

// Section optimization-opportunity score (issue #36) — keyed by node PATH (stable within a
// single extraction session, unlike node ids which are reassigned by extractPage on every
// re-extract). 0-100, "reasons" terse (surfaced only as the badge's hover title, not rendered).
export type SectionScore = { score: number; reason?: string };

export type ParentMsg =
  // hostnameOverride is a debug-only hook (e2e specs) — see lib/runtime.ts's "extract" handler.
  | { t: "extract"; requestId: string; hostnameOverride?: string }
  | { t: "overlay"; on: boolean; requestId: string }
  // Issue #36: pushes/replaces the per-section score set the overlay badges render from. Kept
  // as its own message rather than piggybacked on "overlay" — scores land asynchronously
  // (after the brief resolves), independent of the on/off toggle, and re-sending "overlay"
  // would conflate "toggle visibility" with "here's new data to draw".
  | { t: "scores"; scores: Record<string, SectionScore>; requestId: string }
  | { t: "apply-op"; opId: string; op: import("./types").Op; requestId: string }
  | { t: "revert-op"; opId: string; requestId: string };

export type RuntimeMsg =
  | { t: "ready" }
  | {
      t: "schema";
      nodes: PageNode[];
      seo: import("./types").PageBrief["seo"];
      a11yAudit: import("./types").PageBrief["a11yAudit"];
      requestId?: string;
    }
  | { t: "op-applied"; opId: string; ok: boolean; error?: string; warnings?: string[]; requestId?: string }
  | { t: "op-wiped"; opId: string }
  | { t: "op-reverted"; opId: string; requestId?: string }
  | { t: "selected"; nodeId: string }
  | { t: "overlay-ack"; on: boolean; requestId?: string }
  | { t: "scores-ack"; requestId?: string }
  // A slot-level overlay box click (issue #32). Unsolicited (no parent request preceded it) but
  // still carries a self-generated requestId per the "every postMessage carries a requestId"
  // rule — lib/runtime.ts mints one with its own tiny counter, same pattern as this file's
  // nanoid-lite (runtime.ts must stay dependency-free, so it can't import this module's helper).
  | {
      t: "overlay-select";
      nodeId: string;
      slot: string;
      text: string;
      rect: { x: number; y: number; w: number; h: number };
      requestId: string;
    };

// ── nanoid-lite (no import; runtime must be dependency-free, host can be tiny) ──
let _id = 0;
function nanoid(): string {
  return `${Date.now().toString(36)}-${(++_id).toString(36)}`;
}

// ── IframeHost ─────────────────────────────────────────────────────────────────

type PendingEntry = {
  resolve: (msg: RuntimeMsg) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type UnsolicitedHandler = (msg: RuntimeMsg) => void;

export class IframeHost {
  private iframe: HTMLIFrameElement;
  private pending = new Map<string, PendingEntry>();
  private unsolicitedHandlers = new Set<UnsolicitedHandler>();
  private listener: (e: MessageEvent) => void;
  private timeoutMs: number;

  /**
   * @param opts.timeoutMs Echo timeout in ms (default 30_000 per TECH-SPEC §3). Overridable
   *        so tests can exercise the timeout→reject path without waiting 30s; production
   *        behavior is unchanged when omitted.
   */
  constructor(iframe: HTMLIFrameElement, opts?: { timeoutMs?: number }) {
    this.iframe = iframe;
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
    this.listener = this.handleMessage.bind(this);
    window.addEventListener("message", this.listener);
  }

  /** Subscribe to unsolicited messages (selected, op-wiped, ready) */
  onUnsolicited(handler: UnsolicitedHandler): () => void {
    this.unsolicitedHandlers.add(handler);
    return () => this.unsolicitedHandlers.delete(handler);
  }

  /** Send a message to the iframe and await its echo (by requestId). 30s timeout (default). */
  sendToIframe(msg: { t: string } & Record<string, unknown>): Promise<RuntimeMsg> {
    return new Promise((resolve, reject) => {
      const requestId = nanoid();
      const full = { ...msg, requestId };

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`iframe timeout: ${msg.t} (${requestId})`));
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      const win = this.iframe.contentWindow;
      if (!win) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("iframe not ready"));
        return;
      }

      win.postMessage(full, "*");
    });
  }

  private handleMessage(e: MessageEvent) {
    const msg = e.data as RuntimeMsg & { requestId?: string };
    if (!msg || typeof msg.t !== "string") return;

    // Solicited: resolve the pending promise
    if (msg.requestId && this.pending.has(msg.requestId)) {
      const entry = this.pending.get(msg.requestId)!;
      clearTimeout(entry.timer);
      this.pending.delete(msg.requestId);
      entry.resolve(msg);
      return;
    }

    // Unsolicited (ready, selected, op-wiped) → dispatch to handlers
    for (const handler of this.unsolicitedHandlers) {
      handler(msg);
    }
  }

  destroy() {
    window.removeEventListener("message", this.listener);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("IframeHost destroyed"));
    }
    this.pending.clear();
  }
}
