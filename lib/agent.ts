/**
 * lib/agent.ts — TECH-SPEC §5, the browser agent loop.
 *
 * streamText + our own message array (NOT ToolLoopAgent, NOT useChat) — custom transcript
 * rendering and in-process apply_op approval require it.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { buildSystem } from "./prompts";
import { useChatStore, useSchemaStore, useSettingsStore } from "./store";
import type { SendToIframe } from "./tools";
import { makeTools } from "./tools";
import type { Op } from "./types";

// Client provider — the proxy overwrites this key; the SDK just asserts non-empty (TECH-SPEC §1).
const anthropic = createAnthropic({ apiKey: "proxied", baseURL: "/api/anthropic/v1" });

// Batches per-delta store writes behind requestAnimationFrame (TECH-SPEC §5) — a chatty
// token stream would otherwise re-render the transcript on every few characters.
function batched(flush: (text: string) => void) {
  let buf = "";
  let raf: number | null = null;
  return (delta: string) => {
    buf += delta;
    if (raf !== null) return;
    raf = requestAnimationFrame(() => {
      flush(buf);
      buf = "";
      raf = null;
    });
  };
}

export async function runTurn(userText: string, send: SendToIframe): Promise<void> {
  const chat = useChatStore.getState();
  chat.pushUser(userText);
  chat.setStreaming(true);

  const t0 = performance.now();
  const { model, thinking } = useSettingsStore.getState();
  const tools = makeTools({ send });

  // Prompt caching (TECH-SPEC §5): buildSystem()'s output is the stable prefix — carried on
  // a system message with cacheControl, NOT the streamText `system` shorthand, so we control
  // its providerOptions. Keep its internal field order fixed so edits (not reordering) are
  // the only cache invalidator.
  const systemMsg: ModelMessage = {
    role: "system",
    content: buildSystem(),
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };

  const flushText = batched((text) => useChatStore.getState().appendText(text));
  const flushReasoning = batched((text) => useChatStore.getState().appendReasoning(text));
  // toolCallId -> true for calls we rendered as a `proposal` block (apply_op) rather than a
  // generic `tool` block — the tool-result handler needs to know which path to close.
  const proposalCalls = new Set<string>();

  try {
    const result = streamText({
      model: anthropic(model),
      messages: [systemMsg, ...chat.messages, { role: "user", content: userText }],
      tools,
      stopWhen: stepCountIs(16),
      ...(thinking && {
        providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 8000 } } },
      }),
    });

    for await (const part of result.fullStream) {
      const store = useChatStore.getState();
      switch (part.type) {
        case "text-delta":
          flushText((part as { text?: string; delta?: string }).text ?? (part as { delta?: string }).delta ?? "");
          break;
        case "reasoning-delta":
          flushReasoning(
            (part as { text?: string; delta?: string }).text ?? (part as { delta?: string }).delta ?? ""
          );
          break;
        case "tool-call": {
          const p = part as { toolCallId: string; toolName: string; input: unknown };
          if (p.toolName === "apply_op") {
            const input = p.input as { target: string; slots: Op["slots"]; rationale: string };
            const op: Op = { op: "update-content", target: input.target, slots: input.slots, rationale: input.rationale };
            proposalCalls.add(p.toolCallId);
            store.openProposal(p.toolCallId, op);
          } else {
            store.openTool(p.toolCallId, p.toolName, p.input);
          }
          break;
        }
        case "tool-result": {
          const p = part as { toolCallId: string; toolName: string; output: unknown };
          if (proposalCalls.has(p.toolCallId)) {
            store.closeProposal(p.toolCallId, p.output);
          } else {
            store.closeTool(p.toolCallId, p.output);
          }
          break;
        }
        case "tool-error": {
          // A tool that threw across the boundary (defense-in-depth — tools.ts already
          // converts send-rejects to string results). Close the block with error status so
          // the ToolCallRow/ProposalCard never wedges "running"/"pending" forever.
          const p = part as { toolCallId: string; toolName?: string; error: unknown };
          const reason = p.error instanceof Error ? p.error.message : String(p.error);
          if (proposalCalls.has(p.toolCallId)) store.closeProposal(p.toolCallId, { applied: false, reason });
          else store.closeTool(p.toolCallId, { error: reason });
          store.pushError(`tool ${p.toolName ?? ""} failed: ${reason}`);
          break;
        }
        case "error":
          store.pushError(String((part as { error: unknown }).error));
          break;
        default:
          break; // start, start-step, tool-input-*, finish-step, text-start/end, finish — ignored
      }
    }

    const usage = await result.usage;
    // response.messages does NOT include the user turn — commitTurn appends both.
    const responseMsgs = (await result.response).messages;
    useChatStore.getState().commitTurn({ role: "user", content: userText }, responseMsgs, {
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      ms: performance.now() - t0,
    });
  } catch (e) {
    useChatStore.getState().pushError(e instanceof Error ? e.message : String(e));
  } finally {
    useChatStore.getState().setStreaming(false);
  }
}

/** First turn on page load: extraction has already run; the agent narrates it (TECH-SPEC §5 — the agent never calls ingest/extract itself). */
export async function runFirstTurn(send: SendToIframe): Promise<void> {
  const nodeCount = useSchemaStore.getState().order.length;
  const prompt =
    nodeCount > 0
      ? "[page loaded] The page has been extracted. Introduce yourself briefly and give me a mini-brief on what you see, referencing the actual hero content."
      : "[page loaded] Extraction ran but found no identifiable components (no hero). Say so plainly.";
  await runTurn(prompt, send);
}
