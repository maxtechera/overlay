"use client";

/**
 * components/MessageList.tsx — TECH-SPEC §9: switch on block.kind -> AI Elements/custom block.
 * apply_op's tool-call opens a `proposal` block (not `tool`) — matched by toolName upstream in
 * lib/agent.ts, so MessageList just renders whatever kind the store already produced.
 *
 * M3 (#3): threads `send` down to VariantGalleryBlock — its cards' "click switches the preview"
 * interaction (TECH-SPEC §9) needs the same iframe round-trip as ChatPane's composer.
 *
 * Issue #28 (item 2, "quieter transcript"): consecutive `tool`/`reasoning` blocks are the
 * agent's scratch work (list_components/read_component calls, thinking deltas) — real signal
 * for a demo of "you watch it think", but a firehose across a whole session. They're grouped
 * into ONE collapsed "working… (N steps)" line per contiguous run; expanding it reveals the
 * original ToolCallRow/ReasoningBlock rows unchanged. Meaningful artifacts (text, proposal,
 * brief, plan, gallery, export, error) stay exactly as prominent as before — grouping only
 * ever touches tool/reasoning runs.
 */

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { BriefArtifact } from "@/components/BriefArtifact";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ExperimentPlanBlock } from "@/components/ExperimentPlan";
import { ExportBlock } from "@/components/Export";
import { ProposalCard } from "@/components/ProposalCard";
import { ReasoningBlock } from "@/components/ReasoningBlock";
import { ToolCallRow } from "@/components/ToolCallRow";
import { VariantGalleryBlock } from "@/components/VariantGallery";
import type { ChatBlock } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";

type NoiseBlock = Extract<ChatBlock, { kind: "tool" }> | Extract<ChatBlock, { kind: "reasoning" }>;
type GroupedItem = { kind: "single"; block: ChatBlock } | { kind: "group"; id: string; blocks: NoiseBlock[] };

function isNoise(block: ChatBlock): block is NoiseBlock {
  return block.kind === "tool" || block.kind === "reasoning";
}

/** Collapse every contiguous run of tool/reasoning blocks into one group entry (order-preserving,
 *  no other block kind is ever touched). */
function groupNoise(blocks: ChatBlock[]): GroupedItem[] {
  const items: GroupedItem[] = [];
  let current: Extract<GroupedItem, { kind: "group" }> | null = null;
  for (const block of blocks) {
    if (isNoise(block)) {
      if (current) {
        current.blocks.push(block);
      } else {
        current = { kind: "group", id: block.id, blocks: [block] };
        items.push(current);
      }
    } else {
      current = null;
      items.push({ kind: "single", block });
    }
  }
  return items;
}

function WorkingGroup({
  group,
  isLastItem,
  streaming,
}: {
  group: Extract<GroupedItem, { kind: "group" }>;
  isLastItem: boolean;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const stepCount = group.blocks.length;
  const lastBlock = group.blocks.at(-1);
  const stillRunning = streaming && isLastItem && lastBlock?.kind === "tool" && lastBlock.status === "running";

  return (
    <Collapsible data-testid="working-group" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
        data-testid="working-group-toggle"
      >
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        <span>
          working… ({stepCount} step{stepCount === 1 ? "" : "s"}){stillRunning ? " …" : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="working-group-content">
        <div className="space-y-2 border-muted border-l-2 py-2 pl-3">
          {group.blocks.map((block, i) =>
            block.kind === "tool" ? (
              <ToolCallRow block={block} key={block.id} />
            ) : (
              <ReasoningBlock block={block} key={block.id} streaming={streaming && isLastItem && i === group.blocks.length - 1} />
            )
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function MessageList({
  blocks,
  send,
  streaming,
}: {
  blocks: ChatBlock[];
  send: SendToIframe;
  streaming: boolean;
}) {
  const items = groupNoise(blocks);

  return (
    <>
      {items.map((item, i) => {
        const isLastItem = i === items.length - 1;

        if (item.kind === "group") {
          return <WorkingGroup group={item} isLastItem={isLastItem} key={item.id} streaming={streaming} />;
        }

        const block = item.block;
        switch (block.kind) {
          case "text":
            return (
              <Message data-testid={block.role === "user" ? "user-message" : "assistant-message"} from={block.role} key={block.id}>
                <MessageContent>
                  <MessageResponse>{block.text}</MessageResponse>
                </MessageContent>
              </Message>
            );
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
