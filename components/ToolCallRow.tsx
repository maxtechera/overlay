"use client";

/**
 * components/ToolCallRow.tsx — one row per non-apply_op tool call/result.
 * Built on AI Elements' Tool (ToolHeader/Input/Output) + a duration readout
 * (TECH-SPEC §5: "Per-tool durations ... show on the ToolCallRow").
 *
 * M2b (#14): read_component's output is a full PageNode — render the real ComponentCard
 * (PRD §4.3: "rendered when the agent mentions/reads a component") alongside the collapsible
 * raw tool output, instead of only a JSON dump.
 */

import { ComponentCard } from "@/components/ComponentCard";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import type { ChatBlock } from "@/lib/store";

function readComponentNodeId(block: Extract<ChatBlock, { kind: "tool" }>): string | null {
  if (block.name !== "read_component" || block.status !== "done") return null;
  const out = block.output as { id?: unknown; path?: unknown; slots?: unknown } | undefined;
  return out && typeof out.id === "string" && typeof out.path === "string" && typeof out.slots === "object"
    ? out.id
    : null;
}

export function ToolCallRow({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const state =
    block.status === "running" ? "input-available" : block.status === "error" ? "output-error" : "output-available";
  const componentNodeId = readComponentNodeId(block);

  return (
    <div className="space-y-2">
      {componentNodeId && <ComponentCard nodeId={componentNodeId} />}
      <Tool data-testid="tool-row" data-tool-name={block.name} data-tool-status={block.status}>
        <ToolHeader state={state} title={block.name} type="dynamic-tool" toolName={block.name} />
        <ToolContent>
          <ToolInput input={block.input} />
          <ToolOutput
            errorText={block.status === "error" ? String((block.output as { error?: string })?.error ?? "error") : undefined}
            output={block.status !== "error" ? block.output : undefined}
          />
          {block.durationMs !== undefined && (
            <div className="text-muted-foreground text-xs" data-testid="tool-duration">
              {Math.round(block.durationMs)}ms
            </div>
          )}
        </ToolContent>
      </Tool>
    </div>
  );
}
