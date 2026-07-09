"use client";

/**
 * components/ChatPane.tsx — transcript (AI Elements Conversation) + composer (PromptInput) +
 * telemetry footer. Wires user submissions to lib/agent.ts's runTurn.
 *
 * M2b (#14): the composer's text now lives in useComposerStore (not local state) so
 * ExperimentPlan's "Build arms" and ComponentCard's "Ask about this" can seed it from outside
 * this tree, and so a preview click's reference chip can be shown/consumed here. Sending
 * prepends `[re: <path>]` to the user text (TECH-SPEC §10) and clears the chip.
 *
 * Issue #32 extends the SAME chip flow for a slot-level overlay box click: the chip carries
 * `slot`/`preview` too, renders as "selected: <slot> — <preview>", and the outgoing note fences
 * the page-derived preview text in `<<<PAGE … PAGE>>>` (TECH-SPEC §6/§8's untrusted-data rule —
 * it's text read off the live target page, same as list_components/read_component's previews).
 */

import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { PromptInput, PromptInputBody, PromptInputSubmit, PromptInputTextarea, PromptInputFooter } from "@/components/ai-elements/prompt-input";
import { MessageList } from "@/components/MessageList";
import { TelemetryFooter } from "@/components/TelemetryFooter";
import { runTurn } from "@/lib/agent";
import { useChatStore, useComposerStore, wrapUntrusted, type ReferenceChip } from "@/lib/store";
import type { SendToIframe } from "@/lib/tools";

/** Build the context note prepended to the next user turn for a reference chip. Slot-level
 *  chips (overlay box click) carry the selected element's preview text as fenced, untrusted
 *  page content; plain node chips (whole-node preview click) keep the original `[re: <path>]`
 *  marker unchanged. */
function buildReferenceNote(chip: ReferenceChip): string {
  if (chip.slot) {
    return `[selected element] path=${chip.path} slot=${chip.slot} text=${wrapUntrusted(chip.preview ?? "")}`;
  }
  return `[re: ${chip.path}]`;
}

export function ChatPane({ send, disabled }: { send: SendToIframe; disabled: boolean }) {
  const blocks = useChatStore((s) => s.blocks);
  const streaming = useChatStore((s) => s.streaming);
  const telemetry = useChatStore((s) => s.telemetry);
  const pendingText = useComposerStore((s) => s.text);
  const setPendingText = useComposerStore((s) => s.setText);
  const referenceChip = useComposerStore((s) => s.referenceChip);
  const setReferenceChip = useComposerStore((s) => s.setReferenceChip);

  const handleSubmit = async (message: { text: string }) => {
    const raw = message.text.trim();
    if (!raw) return;
    const text = referenceChip ? `${buildReferenceNote(referenceChip)} ${raw}` : raw;
    setPendingText("");
    setReferenceChip(null);
    await runTurn(text, send);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-transcript">
      <Conversation>
        <ConversationContent>
          {blocks.length === 0 ? (
            <ConversationEmptyState data-testid="chat-empty-state" description="Send a message to start." title="No messages yet" />
          ) : (
            <MessageList blocks={blocks} send={send} streaming={streaming} />
          )}
        </ConversationContent>
      </Conversation>

      <TelemetryFooter telemetry={telemetry} />

      <div className="p-3">
        {referenceChip && (
          <div className="mb-2 flex items-center gap-2" data-testid="reference-chip">
            <span className="mono rounded-full border border-border px-2.5 py-1 text-xs">
              {referenceChip.slot
                ? `selected: ${referenceChip.slot} — ${(referenceChip.preview ?? "").slice(0, 30)}`
                : `re: ${referenceChip.path}`}
            </span>
            <button
              aria-label="Remove reference"
              data-testid="reference-chip-remove"
              onClick={() => setReferenceChip(null)}
              style={{ fontSize: 11, padding: "2px 6px" }}
              type="button"
            >
              ×
            </button>
          </div>
        )}
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
