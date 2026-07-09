/**
 * lib/section-scores.ts — per-section "optimization opportunity" score (issue #36).
 *
 * A distinct question from lib/com.ts's scoreVariant (which scores a CONTROL vs a VARIANT of
 * the same node — before/after). This scores every extracted section/component AGAINST THE
 * BRIEF: "how much conversion upside is there in fixing this, for this goal, on this page,
 * right now" — there's no "before/after" pair to hand scoreVariant's shape, so this is its own
 * small generateObject pass rather than a call into com.ts (issue #36 file boundary: com.ts's
 * purity/imports are not touched here — this module doesn't import it at all).
 *
 * Same proxy pattern as lib/brief.ts/lib/tools.ts: the key never reaches the browser
 * (TECH-SPEC §1). Fire-and-forget from app/page.tsx, chained after runBriefAndPlan resolves —
 * never throws across its entry point (same discipline as lib/brief.ts).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject } from "ai";
import { z } from "zod";
import { useSchemaStore, useScoresStore, useSessionStore, type SectionScoreEntry } from "./store";

const anthropic = createAnthropic({ apiKey: "proxied", baseURL: "/api/anthropic/v1" });

const SECTION_SCORE_SYSTEM = `You are an optimization-opportunity rater for a single webpage. You receive its conversion brief (may be partial) and a list of extracted sections/components (path, type, a short text preview). For EACH section, score 0-100 how much conversion upside there is in improving it for the stated goal: 0 = little/no opportunity (already strong, on-brief, no gaps), 100 = major opportunity (weak, off-brief, or missing what the brief says this audience needs). Judge only what you see in the preview and the brief — never invent facts about the page. One score plus a terse (<=1 short sentence) reason per section. Score every section given; do not skip any.`;

const sectionScoreSchema = z.object({
  scores: z.array(
    z.object({
      path: z.string(),
      score: z.number().min(0).max(100),
      reason: z.string().max(200).optional(),
    })
  ),
});

/**
 * Kicks off the per-section scoring pass against the CURRENT schema + brief snapshot. Meant to
 * be chained after runBriefAndPlan resolves (app/page.tsx) so the brief is real, not the
 * a11y-only placeholder streamObject seeds before its first partial arrives.
 *
 * Grounds paths app-side (same discipline as lib/brief.ts's ctaAudit / runPlan's targetPath):
 * a score for a path that doesn't match a real extracted node is dropped, never invented.
 * Never throws — a failure just leaves sections unscored (the overlay shows no badge for them).
 */
export async function runSectionScoring(): Promise<void> {
  const schema = useSchemaStore.getState();
  const session = useSessionStore.getState();

  if (schema.order.length === 0) return; // nothing extracted — nothing to score

  const validPaths = new Set(schema.order.map((id) => schema.nodes[id].path));
  const sections = schema.order.map((id) => {
    const n = schema.nodes[id];
    const preview =
      Object.values(n.slots)
        .map((s) => s.text)
        .filter((t): t is string => Boolean(t && t.trim()))
        .join(" · ")
        .slice(0, 200) || "(no text)";
    return { path: n.path, type: n.type, preview };
  });

  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: sectionScoreSchema,
      system: SECTION_SCORE_SYSTEM,
      prompt: JSON.stringify({ brief: session.brief, goal: session.goal, sections }),
    });

    const grounded: Record<string, SectionScoreEntry> = {};
    for (const s of object.scores) {
      if (validPaths.has(s.path)) grounded[s.path] = { score: s.score, reason: s.reason };
    }
    useScoresStore.getState().setScores(grounded);
  } catch (e) {
    console.error("[section-scores] scoring failed", e);
  }
}
