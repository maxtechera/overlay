"use client";

/**
 * components/ChatPane.tsx — transcript (AI Elements Conversation) + composer (PromptInput) +
 * telemetry footer. Wires user submissions to lib/agent.ts's runTurn.
 */

import { useState } from "react";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea, PromptInputFooter } from "@/components/ai-elements/prompt-input";
import { MessageList } from "@/components/MessageList";
import { TelemetryFooter } from "@/components/TelemetryFooter";
import { runTurn } from "@/lib/agent";
import { useChatStore } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";

export function ChatPane({ send, disabled }: { send: SendToIframe; disabled: boolean }) {
  const blocks = useChatStore((s) => s.blocks);
  const streaming = useChatStore((s) => s.streaming);
  const telemetry = useChatStore((s) => s.telemetry);
  const [pendingText, setPendingText] = useState("");

  const handleSubmit = async (message: { text: string }) => {
    const text = message.text.trim();
    if (!text) return;
    setPendingText("");
    await runTurn(text, send);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-transcript">
      <Conversation>
        <ConversationContent>
          {blocks.length === 0 ? (
            <ConversationEmptyState data-testid="chat-empty-state" description="Send a message to start." title="No messages yet" />
          ) : (
            <MessageList blocks={blocks} streaming={streaming} />
          )}
        </ConversationContent>
      </Conversation>

      <TelemetryFooter telemetry={telemetry} />

      <div className="p-3">
        <PromptInput data-testid="prompt-input-form" onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              data-testid="prompt-input-textarea"
              disabled={disabled}
              onChange={(e) => setPendingText(e.currentTarget.value)}
              placeholder={disabled ? "Load a page to start chatting…" : "Ask the agent to change something…"}
              value={pendingText}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputSubmit
              data-testid="prompt-input-submit"
              disabled={disabled || streaming}
              status={streaming ? "streaming" : "ready"}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
