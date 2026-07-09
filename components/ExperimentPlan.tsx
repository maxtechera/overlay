"use client";

/**
 * components/ExperimentPlan.tsx — TECH-SPEC §9's `plan` ChatBlock render + PRD §4.5's
 * ExperimentPlan card. Reads experiments.list live (no payload on the block itself).
 *
 * M3 (#3): "Build arms" seeds the composer with the experiment's REAL id — create_variant's
 * `experimentId` param can't be guessed by the model, so the instruction spells it out
 * explicitly, matching the AGENT_SYSTEM_TEMPLATE rule "create its arms with
 * create_variant(experimentId)" (lib/prompts.ts). Also optimistically flips proposed ->
 * building immediately (PRD §4.5 status flow) — useExperimentsStore.addArm flips it too, once
 * the agent's first create_variant(experimentId) call actually lands; this is just snappier UX.
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useComposerStore, useExperimentsStore } from "@/lib/store";

export function ExperimentPlanBlock() {
  const experiments = useExperimentsStore((s) => s.list);
  const setText = useComposerStore((s) => s.setText);
  const setStatus = useExperimentsStore((s) => s.setStatus);

  if (experiments.length === 0) return null;

  const handleBuildArms = (exp: (typeof experiments)[number]) => {
    if (exp.status === "proposed") setStatus(exp.id, "building");
    // Exactly 2 (PRD §4.5's "1-2 named variants"; the issue's acceptance pass expects 2) —
    // spelled out explicitly since nothing else pins the count and a model left to choose
    // reasonably picks its own (3 angles is a perfectly good answer to an unspecified count).
    setText(
      `Build arms for experiment ${exp.id} ("${exp.name}", target: ${exp.targetPath}) — hypothesis: ${exp.hypothesis}. Call create_variant with experimentId="${exp.id}" EXACTLY 2 times (2 arms, no more, no fewer), each followed by its own apply_op, targeting ONLY ${exp.targetPath}.`
    );
  };

  return (
    <div className="space-y-2" data-testid="experiment-plan">
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
        Experiment Plan ({experiments.length})
      </div>
      {experiments.map((exp) => (
        <Card data-testid="experiment-card" data-experiment-status={exp.status} key={exp.id}>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm" data-testid="experiment-name">
                {exp.name}
              </span>
              <Badge data-testid="experiment-status" variant="outline">
                {exp.status}
              </Badge>
            </div>
            <span className="mono text-muted-foreground text-xs" data-testid="experiment-target">
              target: {exp.targetPath}
            </span>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm" data-testid="experiment-hypothesis">
              {exp.hypothesis}
            </p>
            <Button data-testid="build-arms-btn" onClick={() => handleBuildArms(exp)} size="sm" variant="outline">
              Build arms
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
