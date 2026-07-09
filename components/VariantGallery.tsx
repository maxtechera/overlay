"use client";

/**
 * components/VariantGallery.tsx — TECH-SPEC §9's `gallery` ChatBlock: arms grouped by
 * experiment (ranked by COM delta), best-effort html2canvas thumbnail with a styled fallback
 * card, segment tag, prior-labeled suggested allocation. Variants with no experimentId (e.g.
 * ad-hoc "three hero angles") render ungrouped, ranked the same way. Reads variants/experiments
 * store live — no payload on the block itself (same pattern as BriefArtifact/ExperimentPlan).
 */

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useExperimentsStore, useVariantsStore } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";
import type { Experiment, Variant } from "@/lib/types";
import { suggestedAllocation, switchActiveVariant } from "@/lib/variants";

function VariantCard({
  allocationPct,
  send,
  variant,
}: {
  allocationPct?: number;
  send: SendToIframe;
  variant: Variant;
}) {
  const thumbnail = useVariantsStore((s) => s.thumbnails[variant.id]);
  const activeId = useVariantsStore((s) => s.activeId);

  return (
    <Card
      className="cursor-pointer"
      data-active={activeId === variant.id}
      data-testid="variant-card"
      data-variant-id={variant.id}
      onClick={() => void switchActiveVariant(variant.id, send)}
    >
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
      </CardContent>
    </Card>
  );
}

function rankByDelta(arms: Variant[]): Variant[] {
  return [...arms].sort((a, b) => (b.score?.delta ?? -Infinity) - (a.score?.delta ?? -Infinity));
}

function ExperimentGroup({ arms, experiment, send }: { arms: Variant[]; experiment: Experiment; send: SendToIframe }) {
  const ranked = rankByDelta(arms);
  const allocation = suggestedAllocation(arms);

  return (
    <div className="space-y-2" data-experiment-id={experiment.id} data-testid="gallery-experiment-group">
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
        {experiment.name}{" "}
        <span className="italic" data-testid="gallery-control-allocation">
          (control {(allocation.control * 100).toFixed(0)}% · COM-prior)
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {ranked.map((v) => (
          <VariantCard allocationPct={allocation[v.id]} key={v.id} send={send} variant={v} />
        ))}
      </div>
    </div>
  );
}

export function VariantGalleryBlock({ send }: { send: SendToIframe }) {
  const list = useVariantsStore((s) => s.list);
  const experiments = useExperimentsStore((s) => s.list);

  if (list.length === 0) return null;

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

  const rankedUngrouped = rankByDelta(ungrouped);

  return (
    <div className="space-y-4" data-testid="variant-gallery">
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
        Variant Gallery ({list.length})
      </div>
      {[...byExperiment.entries()].map(([expId, arms]) => {
        const experiment = experiments.find((e) => e.id === expId);
        if (!experiment) return null;
        return <ExperimentGroup arms={arms} experiment={experiment} key={expId} send={send} />;
      })}
      {rankedUngrouped.length > 0 && (
        <div className="space-y-2" data-testid="gallery-ungrouped">
          <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">Other variants</div>
          <div className="grid grid-cols-2 gap-2">
            {rankedUngrouped.map((v) => (
              <VariantCard key={v.id} send={send} variant={v} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
