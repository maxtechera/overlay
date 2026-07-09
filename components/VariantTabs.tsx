"use client";

/**
 * components/VariantTabs.tsx — TECH-SPEC §9's "Control · A · B · +" tabs, rendered above the
 * live preview (not a chat block — this drives WHICH variant is currently rendered in the
 * iframe). Clicking a tab calls switchActiveVariant (revert-to-control + replay, lib/variants.ts).
 * "+" is not itself a creation action (variants are agent-authored, PRD §8 cut: no inline
 * editing) — it seeds the composer so the user can describe the next angle.
 */

import { useComposerStore, useVariantsStore } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";
import { switchActiveVariant } from "@/lib/variants";

const LETTERS = "ABCDEFGHIJ";

export function VariantTabs({ send }: { send: SendToIframe }) {
  const list = useVariantsStore((s) => s.list);
  const activeId = useVariantsStore((s) => s.activeId);
  const setText = useComposerStore((s) => s.setText);

  if (list.length === 0) return null; // nothing to switch between yet

  const tabClass = (active: boolean) =>
    `rounded px-2 py-1 font-mono text-xs transition-colors ${
      active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
    }`;

  return (
    // absolute + z-10: .preview-frame's iframe is `position: absolute; inset: 0` (app/globals.css)
    // and paints above static in-flow siblings regardless of DOM order — an un-positioned tabs
    // bar would render but sit BEHIND the iframe, invisible and unclickable. Floating it as its
    // own top overlay (own stacking context) keeps it visible and interactive above the preview.
    <div
      className="absolute top-0 right-0 left-0 z-10 flex items-center gap-1 border-border border-b bg-background/95 px-2 py-1 backdrop-blur-sm"
      data-testid="variant-tabs"
    >
      <button
        className={tabClass(activeId === "control")}
        data-active={activeId === "control"}
        data-testid="variant-tab-control"
        onClick={() => switchActiveVariant("control", send)}
        type="button"
      >
        Control
      </button>
      {list.map((v, i) => (
        <button
          className={tabClass(activeId === v.id)}
          data-active={activeId === v.id}
          data-testid="variant-tab"
          data-variant-id={v.id}
          key={v.id}
          onClick={() => switchActiveVariant(v.id, send)}
          title={v.name}
          type="button"
        >
          {LETTERS[i] ?? String(i + 1)}
        </button>
      ))}
      <button
        className="rounded px-2 py-1 font-mono text-muted-foreground text-xs hover:bg-muted"
        data-testid="variant-tab-add"
        onClick={() => setText("Create a new variant that ")}
        title="Describe a new variant in the composer"
        type="button"
      >
        +
      </button>
    </div>
  );
}
