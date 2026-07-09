"use client";

/**
 * components/ComponentCard.tsx — PRD §4.3's ComponentCard: rendered when the agent
 * mentions/reads a component (wired into ToolCallRow for `read_component` results). Click →
 * highlight + scroll the real element in the preview iframe (reached directly from the
 * parent, same-origin — does NOT touch lib/runtime.ts, see lib/store.ts's usePreviewStore
 * comment). "Ask about this" seeds the composer (TECH-SPEC §10 two-way click↔chat wiring).
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useComposerStore, usePreviewStore, useSchemaStore } from "@/lib/store";
import type { PageNode } from "@/lib/types";

/** Best-effort highlight+scroll — reaches into the same-origin iframe document directly from
 *  the parent (the same pattern TECH-SPEC §9 uses for the M3 html2canvas thumbnail: parent
 *  reaching into contentDocument, not a runtime.ts postMessage round-trip). Never throws. */
export function highlightAndScroll(iframeEl: HTMLIFrameElement, node: PageNode): boolean {
  try {
    const doc = iframeEl.contentDocument;
    if (!doc) return false;
    const el = doc.querySelector(node.selector.css) as HTMLElement | null;
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = "3px solid #f97316";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 1500);
    return true;
  } catch {
    return false; // cross-origin/detached iframe — best-effort only
  }
}

export function ComponentCard({ nodeId }: { nodeId: string }) {
  const node = useSchemaStore((s) => s.node(nodeId));
  const iframeEl = usePreviewStore((s) => s.iframeEl);
  const setText = useComposerStore((s) => s.setText);

  if (!node) return null;

  const preview = Object.values(node.slots)
    .map((s) => s.text)
    .filter((t): t is string => Boolean(t && t.trim()))
    .join(" · ")
    .slice(0, 140);

  return (
    <Card
      className="cursor-pointer border-l-[3px] border-l-muted-foreground/40 hover:border-l-primary"
      data-node-id={node.id}
      data-testid="component-card"
      onClick={() => iframeEl && highlightAndScroll(iframeEl, node)}
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="font-mono text-primary text-xs uppercase tracking-wide">{node.type}</span>
          <span className="mono text-muted-foreground text-xs">{node.path}</span>
          {node.via && <span className="text-muted-foreground text-xs">via:{node.via}</span>}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm">{preview || "(no text)"}</p>
        {node.facts && (
          <p className="text-muted-foreground text-xs" data-testid="component-facts">
            {[
              node.facts.lines !== undefined ? `${node.facts.lines} lines` : null,
              node.facts.fontPx !== undefined ? `${node.facts.fontPx}px` : null,
              node.facts.contrast !== undefined ? `contrast ${node.facts.contrast}:1` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        <Button
          data-testid="ask-about-btn"
          onClick={(e) => {
            e.stopPropagation();
            setText(`Tell me more about ${node.path}.`);
          }}
          size="sm"
          variant="outline"
        >
          Ask about this
        </Button>
      </CardContent>
    </Card>
  );
}
