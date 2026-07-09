"use client";

/**
 * components/Export.tsx — TECH-SPEC §12 / PRD §4.7's `export` ChatBlock: variant/experiment
 * picker -> a dependency-free, standalone A/B applier (lib/export.ts). Reads
 * variants/experiments/schema stores live (payload-free block, same pattern as
 * VariantGallery/ExperimentPlan). This component only resolves node ids to SelectorRefs
 * (useSchemaStore) and wires the picker/segment-mode UI — the snippet generation itself is pure
 * (lib/export.ts), same isolation as lib/variants.ts's suggestedAllocation.
 *
 * M5 (#10): "the variant as a deployable A/B script" — MVP closes here.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useExperimentsStore, useSchemaStore, useVariantsStore } from "@/lib/store";
import {
  GA4_POSTHOG_DOC_NOTE,
  buildConsoleSnippet,
  buildScriptTag,
  mergeOpsByTarget,
  specForExperiment,
  specForSegment,
  specForVariant,
  type ExportSpec,
} from "@/lib/export";
import { suggestedAllocation } from "@/lib/variants";
import type { Variant } from "@/lib/types";

type Selection = `variant:${string}` | `experiment:${string}` | "";

/** First ungrouped variant, else first experiment with at least one arm, else "" (nothing
 *  exportable yet — the caller already guards on variants.length === 0, but an experiment's
 *  armIds can lag one tick behind create_variant in a race, so this stays defensive). */
function pickDefaultSelection(
  ungrouped: Variant[],
  eligibleExperiments: { id: string; armIds: string[] }[]
): Selection {
  if (ungrouped.length > 0) return `variant:${ungrouped[0].id}`;
  const first = eligibleExperiments[0];
  return first ? `experiment:${first.id}` : "";
}

export function ExportBlock() {
  const variants = useVariantsStore((s) => s.list);
  const experiments = useExperimentsStore((s) => s.list);
  const nodeOf = useSchemaStore((s) => s.node);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [segmentOn, setSegmentOn] = useState(false);
  const [segParam, setSegParam] = useState("utm_source");
  const [segValue, setSegValue] = useState("visitor-b");

  if (variants.length === 0) return null;

  const ungrouped = variants.filter((v) => !v.experimentId);
  const eligibleExperiments = experiments.filter((e) => e.armIds.length > 0);
  const effectiveSelection = selection ?? pickDefaultSelection(ungrouped, eligibleExperiments);
  const selectorOf = (id: string) => nodeOf(id)?.selector;

  let spec: ExportSpec | null = null;

  if (effectiveSelection.startsWith("variant:")) {
    const id = effectiveSelection.slice("variant:".length);
    const variant = variants.find((v) => v.id === id);
    if (variant) {
      const ops = mergeOpsByTarget(variant.ops, selectorOf);
      spec =
        segmentOn && segValue.trim()
          ? specForSegment(
              ops,
              { kind: "param", param: segParam.trim() || "utm_source", value: segValue.trim() },
              `overlay-ab-${variant.id}`
            )
          : specForVariant(ops, `overlay-ab-${variant.id}`);
    }
  } else if (effectiveSelection.startsWith("experiment:")) {
    const id = effectiveSelection.slice("experiment:".length);
    const experiment = experiments.find((e) => e.id === id);
    if (experiment) {
      const arms = experiment.armIds
        .map((armId) => variants.find((v) => v.id === armId))
        .filter((v): v is Variant => Boolean(v));
      const allocation = suggestedAllocation(arms);
      const armOps = arms.map((v) => ({ id: v.id, ops: mergeOpsByTarget(v.ops, selectorOf) }));
      spec = specForExperiment(armOps, allocation, `overlay-ab-${experiment.id}`);
    }
  }

  const scriptTag = spec ? buildScriptTag(spec) : "";
  const consoleSnippet = spec ? buildConsoleSnippet(spec) : "";

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {
      // best-effort — the visible <pre> below is the fallback (select-all/copy manually)
    });
  };

  return (
    <div className="space-y-3" data-testid="export-block">
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">Export</div>

      <select
        className="w-full rounded border border-border bg-transparent p-2 text-sm"
        data-testid="export-picker"
        onChange={(e) => setSelection(e.target.value as Selection)}
        value={effectiveSelection}
      >
        {ungrouped.length === 0 && eligibleExperiments.length === 0 && (
          <option value="">No exportable variants yet</option>
        )}
        {ungrouped.length > 0 && (
          <optgroup label="Variants">
            {ungrouped.map((v) => (
              <option data-testid="export-picker-variant-option" key={v.id} value={`variant:${v.id}`}>
                {v.name}
              </option>
            ))}
          </optgroup>
        )}
        {eligibleExperiments.length > 0 && (
          <optgroup label="Experiments (multi-arm)">
            {eligibleExperiments.map((e) => (
              <option data-testid="export-picker-experiment-option" key={e.id} value={`experiment:${e.id}`}>
                {`${e.name} (${e.armIds.length + 1} arms)`}
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {effectiveSelection.startsWith("variant:") && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs" data-testid="export-segment-toggle-row">
            <input
              checked={segmentOn}
              data-testid="export-segment-toggle"
              onChange={(e) => setSegmentOn(e.target.checked)}
              type="checkbox"
            />
            Segment mode (rule-based, no persistence)
          </label>
          {segmentOn && (
            <div className="flex items-center gap-2 text-xs">
              <span>?</span>
              <input
                className="w-28 rounded border border-border bg-transparent px-1.5 py-1"
                data-testid="export-segment-param"
                onChange={(e) => setSegParam(e.target.value)}
                value={segParam}
              />
              <span>=</span>
              <input
                className="w-28 rounded border border-border bg-transparent px-1.5 py-1"
                data-testid="export-segment-value"
                onChange={(e) => setSegValue(e.target.value)}
                value={segValue}
              />
            </div>
          )}
        </div>
      )}

      {spec && (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">{"<script> tag — paste before </body>"}</span>
              <Button data-testid="export-copy-script-btn" onClick={() => copy(scriptTag)} size="sm" variant="outline">
                Copy &lt;script&gt; tag
              </Button>
            </div>
            <pre
              className="max-h-40 overflow-auto rounded border border-border bg-muted p-2 text-[10px]"
              data-testid="export-script-tag"
            >
              {scriptTag}
            </pre>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                Console version — paste on the ORIGINAL live page, applies immediately
              </span>
              <Button data-testid="export-copy-console-btn" onClick={() => copy(consoleSnippet)} size="sm" variant="outline">
                Copy console version
              </Button>
            </div>
            <pre
              className="max-h-40 overflow-auto rounded border border-border bg-muted p-2 text-[10px]"
              data-testid="export-console-snippet"
            >
              {consoleSnippet}
            </pre>
          </div>

          <p className="text-muted-foreground text-xs" data-testid="export-doc-note">
            {GA4_POSTHOG_DOC_NOTE}
          </p>
        </>
      )}
    </div>
  );
}
