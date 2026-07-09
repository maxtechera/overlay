"use client";

/**
 * components/BriefArtifact.tsx — TECH-SPEC §9/§10: the agent's first-turn artifact. Reads
 * session.brief LIVE (never a chat message — a `{kind:"brief"}` ChatBlock carries no payload;
 * this component IS the render for it) so streamObject's progressive fill (lib/brief.ts) and
 * in-place edits (patchBrief) both show up immediately, no re-render plumbing needed.
 *
 * Editable in place: the short text fields (ICP, problem, value prop, tone, lang) are plain
 * textareas/inputs committed onBlur — a functional MVP editing surface, not full rich editing
 * (arrays like painPoints/objections/ctaAudit/a11yAudit are read-only narration of grounded
 * extraction facts; editing those is out of scope for #14).
 */

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { useSessionStore } from "@/lib/store";

function EditableField({
  label,
  value,
  onCommit,
  testId,
  multiline,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  testId: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const editingRef = useRef(false);

  // Keep local draft synced when the store value changes from elsewhere (e.g. streamObject's
  // progressive fill) — but never clobber text the user is actively editing.
  useEffect(() => {
    if (!editingRef.current) setDraft(value);
  }, [value]);

  const commit = () => {
    editingRef.current = false;
    if (draft !== value) onCommit(draft);
  };

  return (
    <div className="space-y-1">
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
      {multiline ? (
        <textarea
          className="w-full resize-y rounded-md border border-border bg-transparent p-2 text-sm"
          data-testid={testId}
          onBlur={commit}
          onChange={(e) => {
            editingRef.current = true;
            setDraft(e.currentTarget.value);
          }}
          rows={2}
          value={draft}
        />
      ) : (
        <input
          className="w-full rounded-md border border-border bg-transparent p-2 text-sm"
          data-testid={testId}
          onBlur={commit}
          onChange={(e) => {
            editingRef.current = true;
            setDraft(e.currentTarget.value);
          }}
          value={draft}
        />
      )}
    </div>
  );
}

function ListField({ label, items, testId }: { label: string; items?: string[]; testId: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
      <ul className="list-disc space-y-0.5 pl-4 text-sm">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

export function BriefArtifact() {
  const brief = useSessionStore((s) => s.brief);
  const goal = useSessionStore((s) => s.goal);
  const patchBrief = useSessionStore((s) => s.patchBrief);
  const setGoal = useSessionStore((s) => s.setGoal);

  if (!brief) return null;

  // streamObject's partial (deep-partial) fill means ANY nested field may be transiently
  // undefined while a turn is mid-stream — default everything defensively so a half-filled
  // brief renders progressively instead of throwing (caught this live: an undefined
  // painPoints.missed during streaming crashed the whole tree before this guard existed).
  const painPoints = brief.painPoints ?? { addressed: [], missed: [] };
  const objections = brief.objections ?? { handled: [], unhandled: [] };
  const proofAudit = brief.proofAudit ?? { present: [], missing: [] };
  const ctaAudit = brief.ctaAudit ?? [];
  const a11yAudit = brief.a11yAudit ?? [];
  const segments = brief.segments ?? [];
  const suggestedGoals = brief.suggestedGoals ?? [];
  const seoTitle = brief.seo?.title ?? "";

  return (
    <Card className="border-l-[3px] border-l-primary" data-testid="brief-artifact">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="font-mono text-primary text-xs uppercase tracking-wide">Page Brief</span>
          <span className="text-muted-foreground text-xs">{seoTitle || "…"}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <EditableField label="ICP" onCommit={(v) => patchBrief({ icp: v })} testId="brief-icp" value={brief.icp ?? ""} multiline />
        <EditableField
          label="Problem statement"
          onCommit={(v) => patchBrief({ problemStatement: v })}
          testId="brief-problem"
          value={brief.problemStatement ?? ""}
          multiline
        />
        <EditableField
          label="Value proposition"
          onCommit={(v) => patchBrief({ valueProp: v })}
          testId="brief-value-prop"
          value={brief.valueProp ?? ""}
          multiline
        />

        <div className="grid grid-cols-2 gap-3">
          <ListField items={painPoints.addressed} label="Pain points — addressed" testId="brief-pain-addressed" />
          <ListField items={painPoints.missed} label="Pain points — missed" testId="brief-pain-missed" />
          <ListField items={objections.handled} label="Objections — handled" testId="brief-obj-handled" />
          <ListField items={objections.unhandled} label="Objections — unhandled" testId="brief-obj-unhandled" />
          <ListField items={proofAudit.present} label="Proof — present" testId="brief-proof-present" />
          <ListField items={proofAudit.missing} label="Proof — missing" testId="brief-proof-missing" />
        </div>

        {ctaAudit.length > 0 && (
          <div className="space-y-1" data-testid="brief-cta-audit">
            <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">CTA audit</div>
            <ul className="space-y-0.5 text-sm">
              {ctaAudit.map((c, i) => (
                <li key={i}>
                  <span className="mono text-muted-foreground">{c.path}</span> — &quot;{c.text}&quot; ({c.intentStage})
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1" data-testid="brief-ada-audit">
          <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
            ADA / accessibility audit ({a11yAudit.length})
          </div>
          {a11yAudit.length > 0 ? (
            <ul className="space-y-0.5 text-sm">
              {a11yAudit.map((f, i) => (
                <li key={i}>
                  <span className="mono text-muted-foreground">{f.path}</span>: {f.issue}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No findings.</p>
          )}
        </div>

        {segments.length > 0 && (
          <div className="space-y-1" data-testid="brief-segments">
            <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">Segments</div>
            <ul className="space-y-0.5 text-sm">
              {segments.map((seg, i) => (
                <li data-testid="brief-segment" key={i}>
                  <strong>{seg.name}</strong> — signal: <span className="mono">{seg.signal}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <EditableField label="Tone" onCommit={(v) => patchBrief({ tone: v })} testId="brief-tone" value={brief.tone ?? ""} />
          <EditableField label="Language" onCommit={(v) => patchBrief({ lang: v })} testId="brief-lang" value={brief.lang ?? ""} />
        </div>

        {suggestedGoals.length > 0 && (
          <div className="space-y-1">
            <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">Goal</div>
            <Suggestions data-testid="goal-chips">
              {suggestedGoals.map((g) => (
                <Suggestion
                  data-active={g === goal}
                  data-testid="goal-chip"
                  key={g}
                  onClick={() => setGoal(g)}
                  suggestion={g}
                  variant={g === goal ? "default" : "outline"}
                />
              ))}
            </Suggestions>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
