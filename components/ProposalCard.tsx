"use client";

/**
 * components/ProposalCard.tsx — TECH-SPEC §9: a slot-level DIFF. Per changed slot, old value
 * (red/strike) -> new value (green); href/src shown as before->after lines; Approve/Reject
 * resolve apply_op's awaited promise (useApprovalsStore). Auto mode hides the buttons and
 * shows "auto-applied" (M2b wires the mode switch UI; the store default is "ask").
 */

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ChatBlock } from "@/lib/store";
import { useApprovalsStore } from "@/lib/store";

type ProposalBlock = Extract<ChatBlock, { kind: "proposal" }>;

function SlotDiff({ slotKey, before, after }: { slotKey: string; before?: { text?: string; href?: string; src?: string; alt?: string }; after: { text?: string; href?: string; src?: string; alt?: string } }) {
  const rows: { label: string; from?: string; to?: string }[] = [];
  if (after.text !== undefined) rows.push({ label: "text", from: before?.text, to: after.text });
  if (after.href !== undefined) rows.push({ label: "href", from: before?.href, to: after.href });
  if (after.src !== undefined) rows.push({ label: "src", from: before?.src, to: after.src });
  if (after.alt !== undefined) rows.push({ label: "alt", from: before?.alt, to: after.alt });

  return (
    <div className="space-y-1" data-testid="proposal-slot" data-slot-key={slotKey}>
      <div className="font-mono text-muted-foreground text-xs uppercase tracking-wide">{slotKey}</div>
      {rows.map((r) => (
        <div className="text-sm" key={r.label}>
          <div className="text-muted-foreground line-through" data-testid="proposal-old">
            {r.from ?? "(empty)"}
          </div>
          <div className="text-foreground" data-testid="proposal-new">
            {r.to}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProposalCard({ block }: { block: ProposalBlock }) {
  const resolve = useApprovalsStore((s) => s.resolve);

  const handleApprove = () => resolve(block.toolCallId, true);
  const handleReject = () => resolve(block.toolCallId, false);

  return (
    <Card
      className="border-l-[3px] border-l-primary"
      data-proposal-status={block.status}
      data-testid={block.status === "pending" ? "proposal-pending" : `proposal-${block.status}`}
    >
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="font-mono text-primary text-xs uppercase tracking-wide">update-content</span>
          <span className="text-muted-foreground text-xs">{block.op.target}</span>
          {block.status === "approved" && (
            <Badge data-testid="proposal-applied" variant="secondary">
              Applied
            </Badge>
          )}
          {block.status === "rejected" && (
            <Badge data-testid="proposal-rejected-badge" variant="secondary">
              Rejected
            </Badge>
          )}
          {block.score && (
            <Badge variant="outline">
              COM Δ {block.score.delta >= 0 ? "+" : ""}
              {block.score.delta.toFixed(2)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {Object.entries(block.op.slots).map(([key, val]) => (
          <SlotDiff after={val} before={block.before[key]} key={key} slotKey={key} />
        ))}
        <p className="text-muted-foreground text-xs">{block.op.rationale}</p>

        {block.warnings && block.warnings.length > 0 && (
          <div className="text-xs text-yellow-600" data-testid="proposal-warnings">
            {block.warnings.join(" · ")}
          </div>
        )}

        {block.status === "pending" && (
          <div className="flex gap-2">
            <Button data-testid="approve-btn" onClick={handleApprove} size="sm">
              Approve
            </Button>
            <Button data-testid="reject-btn" onClick={handleReject} size="sm" variant="outline">
              Reject
            </Button>
          </div>
        )}
        {block.status === "rejected" && block.reason && (
          <p className="text-muted-foreground text-xs" data-testid="proposal-reject-reason">
            {block.reason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
