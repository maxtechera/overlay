"use client";

/**
 * components/VariantGallery.tsx — TECH-SPEC §9's `gallery` ChatBlock, rebuilt as a compact
 * CAROUSEL (issue #28, item 4; raised to a 5-per-module cap and re-verified by issue #35): one
 * variant at a time, prev/next + dots, each slide showing COM delta + thumbnail + an explicit
 * **Apply** button (drives switchActiveVariant — the same mechanics VariantTabs/the old grid
 * used, just an explicit button now instead of a whole-card click — selecting one is always a
 * deliberate click, never auto-applied). Arms of the SAME experiment are ordered together
 * (ranked by COM delta, best first, weakest included/never hidden) with a shared experiment
 * header + suggested allocation (control fixed 25%, COM-prior); ad-hoc variants (no
 * experimentId) follow, ranked the same way. Reads variants/experiments store live — no
 * payload on the block itself (same pattern as BriefArtifact/ExperimentPlan).
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useChatStore, useExperimentsStore, useVariantsStore } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";
import type { Experiment, Variant } from "@/lib/types";
import { suggestedAllocation, switchActiveVariant } from "@/lib/variants";

function rankByDelta(arms: Variant[]): Variant[] {
  return [...arms].sort((a, b) => (b.score?.delta ?? -Infinity) - (a.score?.delta ?? -Infinity));
}

interface Slide {
  variant: Variant;
  experiment?: Experiment;
}

/** Arms grouped by experiment (ranked by delta, best first) come first, in first-appearance
 *  order; ad-hoc variants (no experimentId) follow, ranked the same way. Flat, ordered list —
 *  the carousel index just walks it. */
function orderedSlides(list: Variant[], experiments: Experiment[]): Slide[] {
  const byExperiment = new Map<string, Variant[]>();
  const ungrouped: Variant[] = [];
  for (const v of list) {
    if (v.experimentId) {
      const arr = byExperiment.get(v.experimentId) ?? [];
      arr.push(v);
      byExperiment.set(v.experimentId, arr);
    } else {
      ungrouped.push(v);
    }
  }

  const slides: Slide[] = [];
  for (const [expId, arms] of byExperiment) {
    const experiment = experiments.find((e) => e.id === expId);
    if (!experiment) continue;
    for (const variant of rankByDelta(arms)) slides.push({ variant, experiment });
  }
  for (const variant of rankByDelta(ungrouped)) slides.push({ variant });
  return slides;
}

function VariantCard({ allocationPct, send, variant }: { allocationPct?: number; send: SendToIframe; variant: Variant }) {
  const thumbnail = useVariantsStore((s) => s.thumbnails[variant.id]);
  const activeId = useVariantsStore((s) => s.activeId);
  const isActive = activeId === variant.id;

  return (
    <Card data-active={isActive} data-testid="variant-card" data-variant-id={variant.id}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-sm" data-testid="variant-name">
            {variant.name}
          </span>
          {variant.score && (
            <Badge data-testid="variant-delta" variant={variant.score.delta >= 0 ? "secondary" : "destructive"}>
              COM Δ {variant.score.delta >= 0 ? "+" : ""}
              {variant.score.delta.toFixed(2)}
            </Badge>
          )}
        </div>
        {variant.segment && (
          <span className="text-muted-foreground text-xs" data-testid="variant-segment">
            segment: {variant.segment}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element -- data URL, not a Next asset
          <img
            alt={`${variant.name} thumbnail`}
            className="w-full rounded border border-border"
            data-testid="variant-thumbnail"
            src={thumbnail}
          />
        ) : (
          <div
            className="flex h-20 w-full items-center justify-center rounded border border-border border-dashed bg-muted px-2 text-center text-muted-foreground text-xs"
            data-testid="variant-thumbnail-fallback"
          >
            {variant.name}
          </div>
        )}
        {allocationPct !== undefined && (
          <div className="text-muted-foreground text-xs" data-testid="variant-allocation">
            suggested: {(allocationPct * 100).toFixed(0)}% <span className="italic">(COM-prior)</span>
          </div>
        )}
        {variant.score && variant.score.reasons.length > 0 && (
          <ul className="space-y-0.5 text-muted-foreground text-xs">
            {variant.score.reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        )}
        <Button
          className="w-full"
          data-testid="variant-apply-btn"
          disabled={isActive}
          onClick={() => void switchActiveVariant(variant.id, send)}
          size="sm"
          variant={isActive ? "secondary" : "default"}
        >
          {isActive ? "Active on preview" : "Apply"}
        </Button>
      </CardContent>
    </Card>
  );
}

export function VariantGalleryBlock({ send }: { send: SendToIframe }) {
  const list = useVariantsStore((s) => s.list);
  const experiments = useExperimentsStore((s) => s.list);
  const [index, setIndex] = useState(0);

  if (list.length === 0) return null;

  const slides = orderedSlides(list, experiments);
  if (slides.length === 0) return null;

  const current = Math.min(index, slides.length - 1);
  const slide = slides[current];
  const allocation = slide.experiment
    ? suggestedAllocation(list.filter((v) => v.experimentId === slide.experiment!.id))
    : undefined;

  const goTo = (i: number) => setIndex(((i % slides.length) + slides.length) % slides.length);

  return (
    <div className="space-y-3" data-testid="variant-gallery">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
          Variant Gallery ({list.length})
        </div>
        <Button data-testid="open-export-btn" onClick={() => useChatStore.getState().pushExport()} size="sm" variant="outline">
          Export
        </Button>
      </div>

      {slide.experiment && (
        <div
          className="font-mono text-muted-foreground text-xs uppercase tracking-wide"
          data-experiment-id={slide.experiment.id}
          data-testid="gallery-experiment-group"
        >
          {slide.experiment.name}{" "}
          <span className="italic" data-testid="gallery-control-allocation">
            (control {((allocation?.control ?? 0.25) * 100).toFixed(0)}% · COM-prior)
          </span>
        </div>
      )}

      <VariantCard allocationPct={slide.experiment ? allocation?.[slide.variant.id] : undefined} send={send} variant={slide.variant} />

      <div className="flex items-center justify-between gap-2">
        <Button
          data-testid="carousel-prev"
          disabled={slides.length <= 1}
          onClick={() => goTo(current - 1)}
          size="sm"
          variant="ghost"
        >
          ← Prev
        </Button>
        <div className="flex items-center gap-1.5" data-testid="carousel-dots">
          {slides.map((s, i) => (
            <button
              aria-label={`Go to variant ${i + 1} of ${slides.length}`}
              className="rounded-full transition-colors"
              data-active={i === current}
              data-testid="carousel-dot"
              key={`${s.variant.id}-${i}`}
              onClick={() => goTo(i)}
              style={{
                width: 7,
                height: 7,
                background: i === current ? "var(--foreground)" : "var(--border)",
              }}
              type="button"
            />
          ))}
        </div>
        <Button
          data-testid="carousel-next"
          disabled={slides.length <= 1}
          onClick={() => goTo(current + 1)}
          size="sm"
          variant="ghost"
        >
          Next →
        </Button>
      </div>
    </div>
  );
}
