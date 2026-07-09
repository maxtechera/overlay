"use client";

/**
 * app/page.tsx — two-pane shell (M1a: shell/ingest/hero-detect/op-pipeline · M1b/#13: agent loop)
 * Chat left · Preview right
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { IframeHost } from "@/lib/protocol";
import { runFirstTurn, runTurn } from "@/lib/agent";
import { runBriefAndPlan } from "@/lib/brief";
import { captureThumbnail } from "@/lib/thumbnail";
import {
  useChatStore,
  useComposerStore,
  useExperimentsStore,
  usePreviewStore,
  useSchemaStore,
  useSessionStore,
  useVariantsStore,
} from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";
import type { PageNode } from "@/lib/types";
import { ChatPane } from "@/components/ChatPane";
import { ContextPanel } from "@/components/ContextPanel";
import { SettingsBar } from "@/components/SettingsBar";
import { VariantTabs } from "@/components/VariantTabs";

// ── types ──────────────────────────────────────────────────────────────────────

type IngestStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; url: string }
  | { state: "error"; reason: string };

type Finding = { path: string; issue: string };

type SchemaStatus =
  | { state: "idle" }
  | { state: "extracting" }
  | { state: "ready"; nodes: PageNode[]; a11yAudit: Finding[] }
  | { state: "none" };

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
  const [overlayOn, setOverlayOn] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<IframeHost | null>(null);

  // Stable wrapper handed to the agent loop + ChatPane — reads the ref at call time so it
  // works across iframe reloads without needing to re-render consumers.
  const send: SendToIframe = useCallback((msg) => {
    const host = hostRef.current;
    if (!host) return Promise.reject(new Error("iframe not ready"));
    return host.sendToIframe(msg);
  }, []);

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
    // Parent-side handle to the SAME-ORIGIN iframe document — ComponentCard's highlight+scroll
    // reaches in directly (lib/store.ts's usePreviewStore comment); never touches runtime.ts.
    usePreviewStore.getState().setIframeEl(iframe);
    // Test hook: expose the host so e2e specs can drive sendToIframe directly (to prove
    // the timeout→reject path and the raw apply/revert mechanics). Harmless in production.
    (window as unknown as { __overlayHost?: IframeHost }).__overlayHost = host;
    // Test hook: expose the schema store so e2e specs can look up a real node id (e.g. the
    // hero's) without the removed hardcoded dev buttons. Harmless in production.
    (window as unknown as { __overlaySchemaStore?: typeof useSchemaStore }).__overlaySchemaStore = useSchemaStore;
    // Test hooks (M2b/#14): session (brief/context/goal) + experiments (plan) stores, so e2e
    // specs can assert on the real generated artifacts (grounding, target-path validity)
    // directly instead of scraping rendered DOM text. Harmless in production.
    (window as unknown as { __overlaySessionStore?: typeof useSessionStore }).__overlaySessionStore = useSessionStore;
    (window as unknown as { __overlayExperimentsStore?: typeof useExperimentsStore }).__overlayExperimentsStore =
      useExperimentsStore;
    // Test hook (M3/#3): variants store, so e2e specs can seed variants/scores directly (the
    // gallery grouping/ranking/allocation math is deterministic app logic — no LLM needed to
    // exercise it) and read back activeId/ops for the tab-switch specs.
    (window as unknown as { __overlayVariantsStore?: typeof useVariantsStore }).__overlayVariantsStore =
      useVariantsStore;
    // Test hook: expose the chat store so e2e specs can poll `streaming` to know when a full
    // agent turn (which may span multiple tool calls) has actually settled, instead of racing
    // the first partial text block that streams in. Harmless in production.
    (window as unknown as { __overlayChatStore?: typeof useChatStore }).__overlayChatStore = useChatStore;
    // Test hook: run a turn directly against a fabricated schema, bypassing ingest — used by
    // the injection-fixture spec (TECH-SPEC §2's SSRF guard rejects localhost, so a real
    // fixture page can't go through /api/ingest; the injection defense lives in the system
    // prompt + tool markers, not the network fetch, so this exercises the right layer).
    (window as unknown as { __overlayRunTurn?: (text: string) => Promise<void> }).__overlayRunTurn = (
      text: string
    ) => runTurn(text, send);
    // Test hook (M3/#3): captureThumbnail is a pure DOM-in/data-URL-out function (no LLM) —
    // exposed so e2e can prove BOTH the success path (a real same-origin iframe) and the
    // fallback path (null/detached iframe) deterministically, without needing html2canvas to
    // actually succeed against a live, cross-origin-image-laden site.
    (window as unknown as { __overlayCaptureThumbnail?: typeof captureThumbnail }).__overlayCaptureThumbnail =
      captureThumbnail;

    const unsub = host.onUnsolicited((msg) => {
      if (msg.t === "ready") {
        setIframeReady(true);
        setSchema({ state: "extracting" });
        useSessionStore.getState().setStatus("extracting");
        host
          .sendToIframe({ t: "extract" })
          .then((res) => {
            if (res.t === "schema") {
              // setExtraction (not setNodes) also stashes seo/a11yAudit on the schema store —
              // lib/brief.ts's BRIEF_PROMPT needs both, and the ADA rollup is spliced into the
              // final brief verbatim (never regenerated by the LLM — TECH-SPEC §6).
              useSchemaStore.getState().setExtraction(res.nodes, res.seo, res.a11yAudit);
              useSessionStore.getState().setStatus("ready");
              setSchema(
                res.nodes.length > 0
                  ? { state: "ready", nodes: res.nodes, a11yAudit: res.a11yAudit }
                  : { state: "none" }
              );
              // Test/debug hooks (same pattern as __overlayApplyMs / __overlayHost) — the
              // full extracted schema + ADA rollup, for e2e specs and devtools spot-checks.
              // Harmless in production; nothing reads these globals. Named __overlaySchema
              // (plain array) — distinct from __overlaySchemaStore (the zustand store hook,
              // used by the M1b agent-loop specs) to avoid a name collision between the two
              // lanes' test hooks.
              (window as unknown as { __overlaySchema?: PageNode[] }).__overlaySchema =
                res.nodes;
              (window as unknown as { __overlayA11y?: Finding[] }).__overlayA11y =
                res.a11yAudit;

              // First turn: extraction already ran (deterministic); the agent narrates it
              // (TECH-SPEC §5 — the agent never calls ingest/extract itself). The Page Brief +
              // Experiment Plan generate ALONGSIDE it (independent structured-generation
              // calls, PRD §2 "alongside it: the Experiment Plan") — not blocking each other.
              void runFirstTurn(send);
              void runBriefAndPlan();
            }
          })
          .catch((e) => {
            setSchema({ state: "none" });
            console.error("[overlay] extract failed", e);
          });
      }

      if (msg.t === "selected") {
        // Preview→chat wiring (TECH-SPEC §10): a click on an identified node becomes a
        // removable reference chip in the composer; sending prepends "[re: <path>]".
        const node = useSchemaStore.getState().node(msg.nodeId);
        if (node) useComposerStore.getState().setReferenceChip({ nodeId: node.id, path: node.path });
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
  }, [send]);

  // ── submit URL ──────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const url = urlInput.trim();
      if (!url) return;

      setIngest({ state: "loading" });
      setSchema({ state: "idle" });
      setIframeReady(false);
      useSchemaStore.getState().setNodes([]);
      useSchemaStore.setState({ seo: null, a11yAudit: [] });
      useExperimentsStore.getState().setList([]);
      useVariantsStore.getState().reset();
      useComposerStore.getState().setReferenceChip(null);
      useSessionStore.getState().setUrl(url); // also loads this hostname's persisted context
      useSessionStore.getState().setStatus("ingesting");
      useSessionStore.getState().setBrief(null);
      useSessionStore.getState().setGoal("");

      // Probe the ingest route — if 422, surface the error before setting iframe.src
      const ingestUrl = `/api/ingest?url=${encodeURIComponent(url)}`;
      try {
        const probe = await fetch(ingestUrl);
        if (!probe.ok) {
          const body = (await probe.json().catch(() => ({ reason: "error" }))) as {
            reason?: string;
          };
          setIngest({ state: "error", reason: body.reason ?? "error" });
          useSessionStore.getState().setStatus("error", body.reason ?? "error");
          return;
        }
      } catch {
        setIngest({ state: "error", reason: "fetch-failed" });
        useSessionStore.getState().setStatus("error", "fetch-failed");
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
        <SettingsBar />
      </div>

      {/* main: chat + preview */}
      <div className="main">
        {/* chat pane */}
        <div className="chat">
          <div className="chat-head">
            <span className="title">Chat</span>
            <span className="sub">agent loop · reasoning · proposals</span>
          </div>

          <ContextPanel />

          {/* deterministic extraction status (independent of the agent's own reply) */}
          <div className="chat-scroll" data-testid="chat-scroll" style={{ flex: "none", maxHeight: 160 }}>
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

            {schema.state === "ready" && heroNodes.length > 0 && (
              <div className="msg agent">
                <div className="who">extraction</div>
                <div className="body" data-testid="schema-msg">
                  <strong>Hero detected:</strong>{" "}
                  <span className="mono">{heroNodes[0].path}</span>
                  {heroNodes[0].via && (
                    <span className="mono" style={{ color: "var(--faint)" }}>
                      {" "}
                      · via:{heroNodes[0].via}
                    </span>
                  )}
                  <br />
                  Headline:{" "}
                  <em>{heroNodes[0].slots.headline?.text?.slice(0, 80) ?? "(none)"}</em>
                  {heroNodes[0].facts && (
                    <span style={{ color: "var(--faint)", fontSize: 12 }}>
                      {" "}
                      ({heroNodes[0].facts.lines ?? "?"} lines · {heroNodes[0].facts.fontPx ?? "?"}
                      px · contrast{" "}
                      {heroNodes[0].facts.contrast !== undefined
                        ? `${heroNodes[0].facts.contrast}:1`
                        : "n/a"}
                      )
                    </span>
                  )}
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

            {/* M2a — full ladder summary + ADA rollup (deterministic, computed off facts) */}
            {schema.state === "ready" && (
              <div className="msg agent">
                <div className="who">extraction</div>
                <div className="body" data-testid="ladder-summary">
                  <span data-testid="section-count">
                    {
                      schema.nodes.filter((n) => n.type === "section" || n.type === "collection")
                        .length
                    }{" "}
                    section(s)/collection(s)
                  </span>
                  {" · "}
                  <span data-testid="card-count">
                    {schema.nodes.filter((n) => n.type === "card").length} card(s)
                  </span>
                  {" · "}
                  <span data-testid="ada-audit">{schema.a11yAudit.length} ADA finding(s)</span>
                  {schema.a11yAudit.length > 0 && (
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
                      {schema.a11yAudit.slice(0, 8).map((f, i) => (
                        <li key={i}>
                          <span className="mono">{f.path}</span>: {f.issue}
                        </li>
                      ))}
                    </ul>
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

            {ingest.state === "idle" && (
              <div className="msg agent" data-testid="empty-state">
                <div className="who">overlay</div>
                <div className="body">
                  Paste any URL above — analysis takes about a minute.
                  <br />
                  <span style={{ color: "var(--faint)", fontSize: 12 }}>
                    URL in → mini-brief out. Ask for a change, approve the diff, watch it apply.
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* dev/overlay controls */}
          {schema.state === "ready" && heroNodes.length > 0 && (
            <div className="chat-input" data-testid="op-controls" style={{ flex: "none" }}>
              <div className="chips">
                <button onClick={handleOverlayToggle} data-testid="overlay-btn">
                  {overlayOn ? "Hide overlay" : "Show overlay"}
                </button>
              </div>
            </div>
          )}

          {/* real agent transcript + composer */}
          <ChatPane disabled={!iframeReady} send={send} />
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
          {ingest.state === "ready" && <VariantTabs send={send} />}
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
