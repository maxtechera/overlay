"use client";

/**
 * components/MessageList.tsx — TECH-SPEC §9: switch on block.kind -> AI Elements/custom block.
 * apply_op's tool-call opens a `proposal` block (not `tool`) — matched by toolName upstream in
 * lib/agent.ts, so MessageList just renders whatever kind the store already produced.
 *
 * M3 (#3): threads `send` down to VariantGalleryBlock — its cards' "click switches the preview"
 * interaction (TECH-SPEC §9) needs the same iframe round-trip as ChatPane's composer.
 */

import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { BriefArtifact } from "@/components/BriefArtifact";
import { ExperimentPlanBlock } from "@/components/ExperimentPlan";
import { ExportBlock } from "@/components/Export";
import { ProposalCard } from "@/components/ProposalCard";
import { ReasoningBlock } from "@/components/ReasoningBlock";
import { ToolCallRow } from "@/components/ToolCallRow";
import { VariantGalleryBlock } from "@/components/VariantGallery";
import type { ChatBlock } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";

export function MessageList({
  blocks,
  send,
  streaming,
}: {
  blocks: ChatBlock[];
  send: SendToIframe;
  streaming: boolean;
}) {
  return (
    <>
      {blocks.map((block, i) => {
        const isLast = i === blocks.length - 1;
        switch (block.kind) {
          case "text":
            return (
              <Message data-testid={block.role === "user" ? "user-message" : "assistant-message"} from={block.role} key={block.id}>
                <MessageContent>
                  <MessageResponse>{block.text}</MessageResponse>
                </MessageContent>
              </Message>
            );
          case "reasoning":
            return <ReasoningBlock block={block} key={block.id} streaming={streaming && isLast} />;
          case "tool":
            return <ToolCallRow block={block} key={block.id} />;
          case "proposal":
            return <ProposalCard block={block} key={block.id} />;
          case "brief":
            return <BriefArtifact key={block.id} />;
          case "plan":
            return <ExperimentPlanBlock key={block.id} />;
          case "gallery":
            return <VariantGalleryBlock key={block.id} send={send} />;
          case "export":
            return <ExportBlock key={block.id} />;
          case "error":
            return (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm" data-testid="agent-error" key={block.id}>
                {block.text}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}
