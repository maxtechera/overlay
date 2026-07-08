// COM — Conversion Optimization Model (lib/com.ts)
// Isolation rule: imports NOTHING from agent.ts or stores. Only: ai, @ai-sdk/anthropic, zod, types.
// Generator ≠ evaluator: the agent never sees this rubric; the COM prompt states the goal but
// never enumerates what "good" looks like.

import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { ComScore, PageBrief } from "./types";

// SlotSnapshot = one entry per CHANGED node (before/after of changed nodes only).
export interface SlotSnapshot {
  path: string;
  slots: Record<string, string>;
}

// COM_SYSTEM: states the goal, never enumerates criteria.
// Placed here (not in prompts.ts) to avoid any file overlap with issue #1's work.
const COM_SYSTEM = `You are an independent conversion-rating model. Input: a page's conversion brief (may be null), a goal, and before/after content for the changed components. Rate control and variant separately (0–1) for how likely each is to achieve the goal for this audience. Judge only what you see; do not assume the variant is better because it is newer. Reasons: concrete, ≤4, terse.`;

const comScoreSchema = z.object({
  control: z.number().min(0).max(1),
  variant: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()).max(4),
});

/** scoreVariant: accepts an optional provider so the browser app can inject a proxy-based
 *  provider later. When provider is omitted, creates one directly using ANTHROPIC_API_KEY
 *  (Node runner path). */
export async function scoreVariant(
  input: {
    brief: PageBrief | null;
    goal: string;
    control: SlotSnapshot[];
    variant: SlotSnapshot[];
  },
  provider?: ReturnType<typeof createAnthropic>
): Promise<ComScore> {
  const anthropic =
    provider ??
    createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    });

  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: comScoreSchema,
    system: COM_SYSTEM,
    prompt: JSON.stringify(input),
  });

  return { ...object, delta: object.variant - object.control };
}
