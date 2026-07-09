/**
 * lib/memory.ts — TECH-SPEC §11 site memory: shared types + pure helpers for the CLIENT side.
 *
 * Deliberately import-free of ./store (server-side fs storage lives in app/api/memory/route.ts;
 * the store additions that READ these stores — useMemoryStore, useVariantsStore.hydrate — live
 * in lib/store.ts, which imports FROM here one-way: store.ts -> memory.ts, never the reverse.
 * That keeps this module safely importable from store.ts without a circular dependency.
 */

import type { Experiment, PageBrief, PageNode, Variant } from "./types";

export interface Verdict {
  opId: string;
  approved: boolean;
  reason?: string;
  at: number; // epoch ms
}

/** app-managed state.json shape (TECH-SPEC §11) — everything extracted + decided. */
export interface MemoryState {
  schema: { nodes: PageNode[]; extractedAt: number };
  seo: PageBrief["seo"] | null;
  brief: PageBrief | null;
  goal: string;
  experiments: Experiment[];
  variants: Variant[];
  verdicts: Verdict[];
}

export interface MemoryPayload {
  memory: string | null;
  context: string | null;
  state: MemoryState | null;
}

/** hostname extraction — same rule the server enforces (TECH-SPEC §11 path safety). */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** GET /api/memory?site=<hostname> — never throws; null on any failure (fresh session = null). */
export async function fetchMemory(site: string): Promise<MemoryPayload | null> {
  try {
    const res = await fetch(`/api/memory?site=${encodeURIComponent(site)}`);
    if (!res.ok) return null;
    return (await res.json()) as MemoryPayload;
  } catch {
    return null;
  }
}

/** POST /api/memory — fire-and-forget save trigger; NEVER throws (CLAUDE.md hard rule). */
export async function postMemory(
  site: string,
  patch: { memory?: string; context?: string; state?: MemoryState }
): Promise<void> {
  try {
    await fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site, ...patch }),
    });
  } catch {
    // fire-and-forget — a save failure must never surface as a chat error (CLAUDE.md)
  }
}

/** Normalized text prefix — same shape as lib/runtime.ts's hero SelectorRef fingerprint. */
function fingerprintOf(node: PageNode): string {
  const headline = Object.values(node.slots)
    .map((s) => s.text)
    .find((t): t is string => Boolean(t));
  return (headline ?? "").trim().toLowerCase().slice(0, 40);
}

export interface SchemaDiff {
  stalePaths: Set<string>; // paths present in `saved` whose fingerprint moved or vanished
}

/**
 * Diff fresh extraction vs the saved snapshot by path+fingerprint (TECH-SPEC §11 resume flow):
 * "fingerprints that moved or vanished get flagged... instead of silently trusted." Pure —
 * no store reads, easy to unit-test and to call from the resume-time effect in app/page.tsx.
 */
export function diffSchema(fresh: PageNode[], saved: PageNode[] | undefined | null): SchemaDiff {
  const stalePaths = new Set<string>();
  if (!saved || saved.length === 0) return { stalePaths };
  const savedByPath = new Map(saved.map((n) => [n.path, n]));
  const freshByPath = new Map(fresh.map((n) => [n.path, n]));
  for (const [path, savedNode] of savedByPath) {
    const freshNode = freshByPath.get(path);
    if (!freshNode) {
      stalePaths.add(path); // moved or missing entirely
      continue;
    }
    if (fingerprintOf(freshNode) !== fingerprintOf(savedNode)) stalePaths.add(path);
  }
  return { stalePaths };
}

/** Count of durable learnings in memory.md — crude but stable: one non-blank line ~= one note. */
export function countLearnings(memoryMd: string): number {
  return memoryMd
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;
}

/**
 * "Back on posthog.com — 3 learnings on file, last variant scored +0.12, hero unchanged"
 * (PRD §4.6 / TECH-SPEC §14 signature moment). Pure text builder — lib/agent.ts's
 * runFirstTurn feeds this into the first-turn prompt when useMemoryStore.resumeSummary is set.
 */
export function buildResumeSummary(opts: {
  learningsCount: number;
  lastScoreDelta?: number;
  heroStale: boolean;
}): string {
  const parts: string[] = [
    `${opts.learningsCount} learning${opts.learningsCount === 1 ? "" : "s"} on file`,
  ];
  if (opts.lastScoreDelta !== undefined) {
    const sign = opts.lastScoreDelta >= 0 ? "+" : "";
    parts.push(`last variant scored ${sign}${opts.lastScoreDelta.toFixed(2)}`);
  }
  parts.push(opts.heroStale ? "hero changed since last session" : "hero unchanged");
  return parts.join(", ");
}
