/**
 * lib/protocol.ts — iframe postMessage protocol + IframeHost bridge
 * TECH-SPEC §3
 *
 * Every message carries a requestId (nanoid). Unsolicited messages (selected, op-wiped)
 * have no requestId — they are dispatched directly to callbacks.
 */

import type { PageNode } from "./types";

// ── Message types ──────────────────────────────────────────────────────────────

export type ParentMsg =
  | { t: "extract"; requestId: string }
  | { t: "overlay"; on: boolean; requestId: string }
  | { t: "apply-op"; opId: string; op: import("./types").Op; requestId: string }
  | { t: "revert-op"; opId: string; requestId: string };

export type RuntimeMsg =
  | { t: "ready" }
  | { t: "schema"; nodes: PageNode[]; seo: import("./types").PageBrief["seo"]; requestId?: string }
  | { t: "op-applied"; opId: string; ok: boolean; error?: string; warnings?: string[]; requestId?: string }
  | { t: "op-wiped"; opId: string }
  | { t: "op-reverted"; opId: string; requestId?: string }
  | { t: "selected"; nodeId: string }
  | { t: "overlay-ack"; on: boolean; requestId?: string };

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

  constructor(iframe: HTMLIFrameElement) {
    this.iframe = iframe;
    this.listener = this.handleMessage.bind(this);
    window.addEventListener("message", this.listener);
  }

  /** Subscribe to unsolicited messages (selected, op-wiped, ready) */
  onUnsolicited(handler: UnsolicitedHandler): () => void {
    this.unsolicitedHandlers.add(handler);
    return () => this.unsolicitedHandlers.delete(handler);
  }

  /** Send a message to the iframe and await its echo (by requestId). 30s timeout. */
  sendToIframe(msg: { t: string } & Record<string, unknown>): Promise<RuntimeMsg> {
    return new Promise((resolve, reject) => {
      const requestId = nanoid();
      const full = { ...msg, requestId };

      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`iframe timeout: ${msg.t} (${requestId})`));
      }, 30_000);

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
