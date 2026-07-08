"use client";

/**
 * components/ToolCallRow.tsx — one row per non-apply_op tool call/result.
 * Built on AI Elements' Tool (ToolHeader/Input/Output) + a duration readout
 * (TECH-SPEC §5: "Per-tool durations ... show on the ToolCallRow").
 */

import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import type { ChatBlock } from "@/lib/store";

export function ToolCallRow({ block }: { block: Extract<ChatBlock, { kind: "tool" }> }) {
  const state =
    block.status === "running" ? "input-available" : block.status === "error" ? "output-error" : "output-available";

  return (
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
  );
}
