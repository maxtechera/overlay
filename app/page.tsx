"use client";

/**
 * app/page.tsx — two-pane shell (Step 1–4, M1a)
 * Chat left · Preview right
 * No agent in this issue — chat echoes input; hardcoded op button drives the pipeline.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IframeHost } from "@/lib/protocol";
import type { PageNode, Op } from "@/lib/types";

// ── types ──────────────────────────────────────────────────────────────────────

type IngestStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; url: string }
  | { state: "error"; reason: string };

type SchemaStatus =
  | { state: "idle" }
  | { state: "extracting" }
  | { state: "ready"; nodes: PageNode[] }
  | { state: "none" };

type OpState =
  | { state: "idle" }
  | { state: "applied"; opId: string; prevText: string; newText: string }
  | { state: "error"; reason: string };

// ── helpers ───────────────────────────────────────────────────────────────────

function statusLabel(ingest: IngestStatus, schema: SchemaStatus): string {
  if (ingest.state === "loading") return "ingesting…";
  if (ingest.state === "error") return `error: ${ingest.reason}`;
  if (schema.state === "extracting") return "extracting…";
  if (schema.state === "ready") return `${schema.nodes.length} node(s) detected`;
  if (schema.state === "none") return "no hero found";
  return "";
}

// ── component ─────────────────────────────────────────────────────────────────

export default function Home() {
  const [urlInput, setUrlInput] = useState("");
  const [ingest, setIngest] = useState<IngestStatus>({ state: "idle" });
  const [schema, setSchema] = useState<SchemaStatus>({ state: "idle" });
  const [opState, setOpState] = useState<OpState>({ state: "idle" });
  const [overlayOn, setOverlayOn] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<IframeHost | null>(null);
  const schemaNodesRef = useRef<PageNode[]>([]);

  // ── IframeHost setup ────────────────────────────────────────────────────────
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Test hook: ?hostTimeoutMs=<n> shortens the echo timeout so e2e can exercise the
    // timeout→reject path without waiting the default 30s (TECH-SPEC §3). Omitted in
    // normal use, so production behavior (30s default) is unchanged.
    const timeoutParam = new URLSearchParams(window.location.search).get("hostTimeoutMs");
    const timeoutMs = timeoutParam ? Number(timeoutParam) : undefined;

    const host = new IframeHost(iframe, timeoutMs ? { timeoutMs } : undefined);
    hostRef.current = host;
    // Test hook: expose the host so e2e specs can drive sendToIframe directly (to prove
    // the timeout→reject path). Harmless in production — nothing reads this global.
    (window as unknown as { __overlayHost?: IframeHost }).__overlayHost = host;

    const unsub = host.onUnsolicited((msg) => {
      if (msg.t === "ready") {
        setIframeReady(true);
        setSchema({ state: "extracting" });
        host
          .sendToIframe({ t: "extract" })
          .then((res) => {
            if (res.t === "schema") {
              schemaNodesRef.current = res.nodes;
              setSchema(
                res.nodes.length > 0
                  ? { state: "ready", nodes: res.nodes }
                  : { state: "none" }
              );
            }
          })
          .catch((e) => {
            setSchema({ state: "none" });
            console.error("[overlay] extract failed", e);
          });
      }

      if (msg.t === "selected") {
        console.log("[overlay] selected", msg.nodeId);
      }

      if (msg.t === "op-wiped") {
        console.warn("[overlay] op-wiped", msg.opId);
      }
    });

    return () => {
      unsub();
      host.destroy();
      hostRef.current = null;
    };
  }, []);

  // ── submit URL ──────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const url = urlInput.trim();
      if (!url) return;

      setIngest({ state: "loading" });
      setSchema({ state: "idle" });
      setOpState({ state: "idle" });
      setIframeReady(false);
      schemaNodesRef.current = [];

      // Probe the ingest route — if 422, surface the error before setting iframe.src
      const ingestUrl = `/api/ingest?url=${encodeURIComponent(url)}`;
      try {
        const probe = await fetch(ingestUrl);
        if (!probe.ok) {
          const body = (await probe.json().catch(() => ({ reason: "error" }))) as {
            reason?: string;
          };
          setIngest({ state: "error", reason: body.reason ?? "error" });
          return;
        }
      } catch {
        setIngest({ state: "error", reason: "fetch-failed" });
        return;
      }

      setIngest({ state: "ready", url });
      const iframe = iframeRef.current;
      if (iframe) {
        iframe.src = ingestUrl;
      }
    },
    [urlInput]
  );

  // ── overlay toggle ──────────────────────────────────────────────────────────
  const handleOverlayToggle = useCallback(async () => {
    const host = hostRef.current;
    if (!host || !iframeReady) return;
    const next = !overlayOn;
    setOverlayOn(next);
    try {
      await host.sendToIframe({ t: "overlay", on: next });
    } catch (e) {
      console.error("[overlay] overlay toggle failed", e);
    }
  }, [overlayOn, iframeReady]);

  // ── hardcoded op pipeline (Step 4) ─────────────────────────────────────────
  const handleApplyOp = useCallback(async () => {
    // Real in-app latency for the M1a "<500ms apply" criterion (PRD.md:497,
    // TECH-SPEC.md:543): approve-handler-start -> op-applied received. The iframe
    // runtime mutates the DOM before it replies op-applied, so this is a conservative
    // upper bound on visible-change latency — it excludes Playwright's own
    // click-actionability and toBeVisible() polling overhead, neither of which is
    // part of the product's round-trip. Test-only read; harmless in production.
    const t0 = performance.now();

    const host = hostRef.current;
    if (!host || !iframeReady) return;

    const nodes = schemaNodesRef.current;
    const hero = nodes.find((n) => n.type === "hero");
    if (!hero) return;

    const originalText = hero.slots.headline?.text ?? "Hero Headline";
    const newText = "[OVERLAY TEST] Hero rewritten by op pipeline";
    const opId = `test-op-${Date.now()}`;

    const op: Op = {
      op: "update-content",
      target: hero.id,
      slots: { headline: { text: newText } },
      rationale: "Hardcoded test op — M1a step 4",
    };

    try {
      const res = await host.sendToIframe({ t: "apply-op", opId, op });
      if (res.t === "op-applied" && res.ok) {
        setOpState({ state: "applied", opId, prevText: originalText, newText });
        (window as unknown as { __overlayApplyMs?: number }).__overlayApplyMs =
          performance.now() - t0;
      } else {
        const error = res.t === "op-applied" ? (res.error ?? "unknown") : "unexpected-msg";
        setOpState({ state: "error", reason: error });
      }
    } catch (e) {
      setOpState({ state: "error", reason: String(e) });
    }
  }, [iframeReady]);

  const handleRevertOp = useCallback(async () => {
    const host = hostRef.current;
    if (!host || opState.state !== "applied") return;
    const { opId } = opState;
    try {
      await host.sendToIframe({ t: "revert-op", opId });
      setOpState({ state: "idle" });
    } catch (e) {
      console.error("[overlay] revert failed", e);
    }
  }, [opState]);

  // ── render ──────────────────────────────────────────────────────────────────
  const heroNodes =
    schema.state === "ready" ? schema.nodes.filter((n) => n.type === "hero") : [];
  const statusStr = statusLabel(ingest, schema);

  return (
    <div className="shell">
      {/* top bar */}
      <div className="topbar">
        <span className="brand">
          over<span className="dot">.</span>lay
        </span>
        <form onSubmit={handleSubmit}>
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="Paste any URL — analysis takes about a minute"
            aria-label="Target URL"
            data-testid="url-input"
          />
          <button type="submit" className="primary" disabled={ingest.state === "loading"}>
            {ingest.state === "loading" ? "Loading…" : "Analyze"}
          </button>
        </form>
        {statusStr && (
          <span
            className={`schema-count ${ingest.state === "error" ? "err" : ""}`}
            style={{ whiteSpace: "nowrap" }}
            data-testid="status"
          >
            {statusStr}
          </span>
        )}
      </div>

      {/* main: chat + preview */}
      <div className="main">
        {/* chat pane */}
        <div className="chat">
          <div className="chat-head">
            <span className="title">Chat</span>
            <span className="sub">M1a — foundation (no agent)</span>
          </div>
          <div className="chat-scroll" data-testid="chat-scroll">
            {/* error */}
            {ingest.state === "error" && (
              <div className="msg agent">
                <div className="who">system</div>
                <div className="body" data-testid="error-msg">
                  Could not load page:{" "}
                  <strong>{ingest.reason}</strong>
                  {ingest.reason === "bot-wall" && (
                    <> — this site blocks automated access.</>
                  )}
                  {ingest.reason === "upstream-error" && (
                    <> — the server returned an error.</>
                  )}
                </div>
              </div>
            )}

            {/* schema results */}
            {schema.state === "ready" && heroNodes.length > 0 && (
              <div className="msg agent">
                <div className="who">extraction</div>
                <div className="body" data-testid="schema-msg">
                  <strong>Hero detected:</strong>{" "}
                  <span className="mono">{heroNodes[0].path}</span>
                  <br />
                  Headline:{" "}
                  <em>{heroNodes[0].slots.headline?.text?.slice(0, 80) ?? "(none)"}</em>
                  {heroNodes[0].slots.subhead && (
                    <>
                      <br />
                      Subhead:{" "}
                      <em>{heroNodes[0].slots.subhead.text?.slice(0, 80)}</em>
                    </>
                  )}
                  {heroNodes[0].slots.cta && (
                    <>
                      <br />
                      CTA: <em>{heroNodes[0].slots.cta.text}</em>
                    </>
                  )}
                </div>
              </div>
            )}

            {schema.state === "none" && (
              <div className="msg agent">
                <div className="who">extraction</div>
                <div className="body" data-testid="no-hero-msg">
                  No hero component identified on this page.
                </div>
              </div>
            )}

            {/* op result */}
            {opState.state === "applied" && (
              <div className="proposal applied" data-testid="proposal-applied">
                <div className="op">
                  update-content{" "}
                  <span className="target">hero.headline</span>
                </div>
                <div className="value">
                  <span className="old">{opState.prevText}</span>
                  <span className="new">{opState.newText}</span>
                </div>
                <div className="rationale">
                  Hardcoded test op — M1a step 4 pipeline verification.
                </div>
                <div className="actions">
                  <button
                    className="small"
                    onClick={handleRevertOp}
                    data-testid="revert-btn"
                  >
                    Revert
                  </button>
                </div>
              </div>
            )}

            {opState.state === "error" && (
              <div className="msg agent">
                <div className="who">error</div>
                <div
                  className="body"
                  style={{ color: "var(--red)" }}
                  data-testid="op-error-msg"
                >
                  Op failed: {opState.reason}
                </div>
              </div>
            )}

            {/* empty state */}
            {ingest.state === "idle" && (
              <div className="msg agent" data-testid="empty-state">
                <div className="who">overlay</div>
                <div className="body">
                  Paste any URL above — analysis takes about a minute.
                  <br />
                  <span style={{ color: "var(--faint)", fontSize: 12 }}>
                    M1a: shell · ingest · hero detection · op pipeline
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* dev op controls */}
          {schema.state === "ready" && heroNodes.length > 0 && (
            <div className="chat-input" data-testid="op-controls">
              <div className="chips">
                <button
                  onClick={handleApplyOp}
                  disabled={opState.state === "applied"}
                  data-testid="apply-btn"
                >
                  Apply test op
                </button>
                <button
                  onClick={handleRevertOp}
                  disabled={opState.state !== "applied"}
                  data-testid="revert-chip-btn"
                >
                  Revert
                </button>
                <button onClick={handleOverlayToggle} data-testid="overlay-btn">
                  {overlayOn ? "Hide overlay" : "Show overlay"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* preview pane */}
        <div className="preview-frame">
          {ingest.state === "idle" && (
            <div className="empty" data-testid="preview-empty">
              <div className="big">Paste a URL to preview</div>
              <div style={{ color: "var(--faint)", fontSize: 12 }}>
                Overlay fetches, rewrites, and renders the page here
              </div>
            </div>
          )}
          {ingest.state === "loading" && (
            <div className="empty">
              <div className="thinking">
                <span className="d" />
                <span className="d" />
                <span className="d" />
              </div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            title="Page preview"
            data-testid="preview-iframe"
            style={{
              display:
                ingest.state === "ready" ? "block" : "none",
              width: "100%",
              height: "100%",
              border: "none",
            }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      </div>
    </div>
  );
}
