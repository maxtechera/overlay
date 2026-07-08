"use client";

/**
 * components/ReasoningBlock.tsx — collapsible reasoning block, streams while thinking
 * (PRD §4.3: "you watch it think, like Claude Code").
 */

import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import type { ChatBlock } from "@/lib/store";

export function ReasoningBlock({ block, streaming }: { block: Extract<ChatBlock, { kind: "reasoning" }>; streaming: boolean }) {
  return (
    <Reasoning data-testid="reasoning-block" isStreaming={streaming}>
      <ReasoningTrigger />
      <ReasoningContent>{block.text}</ReasoningContent>
    </Reasoning>
  );
}
