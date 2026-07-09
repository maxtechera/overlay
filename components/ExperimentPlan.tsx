"use client";

/**
 * components/ExperimentPlan.tsx — TECH-SPEC §9's `plan` ChatBlock render + PRD §4.5's
 * ExperimentPlan card. Reads experiments.list live (no payload on the block itself). "Build
 * arms" seeds the composer (create_variant/the arms mechanism itself is M3 — #14 only owns
 * getting the instruction into the composer, per the issue's deliverable).
 */

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useComposerStore, useExperimentsStore } from "@/lib/store";

export function ExperimentPlanBlock() {
  const experiments = useExperimentsStore((s) => s.list);
  const setText = useComposerStore((s) => s.setText);

  if (experiments.length === 0) return null;

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
              <Badge variant="outline">{exp.status}</Badge>
            </div>
            <span className="mono text-muted-foreground text-xs" data-testid="experiment-target">
              target: {exp.targetPath}
            </span>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm" data-testid="experiment-hypothesis">
              {exp.hypothesis}
            </p>
            <Button
              data-testid="build-arms-btn"
              onClick={() =>
                setText(
                  `Build arms for experiment "${exp.name}" (target: ${exp.targetPath}) — ${exp.hypothesis}`
                )
              }
              size="sm"
              variant="outline"
            >
              Build arms
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
