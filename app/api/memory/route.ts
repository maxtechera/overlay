/**
 * app/api/memory/route.ts — TECH-SPEC §11 (site memory, "a CLAUDE.md for the website").
 *
 * GET  ?site=<hostname> -> { memory: string|null, context: string|null, state: MemoryState|null }
 * POST { site, memory?, context?, state? } -> writes whichever key is present, mkdir -p the
 * folder. `.memory/` is app data, gitignored — never committed (CLAUDE.md hard rule).
 *
 * Path safety (TECH-SPEC §11): `site` must match /^[a-z0-9.-]+$/i (no slashes -> no traversal
 * via separators) AND must not contain ".." as a substring (a bare ".." would otherwise pass
 * the character-class regex — both chars are in it). The resolved directory is also asserted to
 * stay under MEMORY_ROOT as defense-in-depth. Server fs, single-user-grade — no library.
 *
 * Durability (PR #41 round-2 review — a real data-loss bug): `fs.writeFile` is NOT atomic —
 * two concurrent POSTs for the same site (e.g. the debounced autosave firing while a manual
 * save_memory call is also in flight) can interleave their writes on the SAME file and produce
 * unparseable JSON; GET's `catch { state = null }` then SILENTLY discards the entire saved
 * session. Fixed two ways:
 *   1. atomicWriteFile: write to a temp file in the SAME directory, then `fs.rename` — rename
 *      is atomic on the same filesystem, so a reader only ever sees the fully-old or fully-new
 *      content, never a torn write.
 *   2. withSiteLock: an in-process per-hostname promise chain so a site's writes never overlap
 *      even in issue order (not just non-corrupting — logically serialized too).
 */

import { promises as fs } from "fs";
import path from "path";
import { requireAuth } from "@/lib/auth";
import type { MemoryState } from "@/lib/memory";

const MEMORY_ROOT = path.join(process.cwd(), ".memory");
const SITE_PATTERN = /^[a-z0-9.-]+$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Resolves `site` to its `.memory/<site>` directory, or null if it fails path-safety. */
function siteDir(site: string | null): string | null {
  if (!site || !SITE_PATTERN.test(site) || site.includes("..")) return null;
  const dir = path.join(MEMORY_ROOT, site);
  const resolvedRoot = path.resolve(MEMORY_ROOT) + path.sep;
  if (!path.resolve(dir).startsWith(resolvedRoot)) return null; // belt-and-suspenders
  return dir;
}

/** write-to-temp + rename — atomic on the same filesystem, so readers never see a torn write. */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// In-process per-hostname promise chain — every POST for a given site queues behind the
// previous one instead of racing it on disk. Module-scoped (survives across requests within
// this server process; a fresh process — e.g. a redeploy — starts with an empty map, which is
// fine since there's nothing in flight to serialize against yet).
const siteLocks = new Map<string, Promise<unknown>>();

function withSiteLock<T>(site: string, fn: () => Promise<T>): Promise<T> {
  const prior = siteLocks.get(site) ?? Promise.resolve();
  const next = prior.then(fn, fn); // run fn regardless of whether the PRIOR write rejected
  siteLocks.set(
    site,
    next.catch(() => {})
  ); // swallow so a rejection here never wedges the chain for the NEXT caller
  return next;
}

export async function GET(req: Request): Promise<Response> {
  const denied = requireAuth(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const dir = siteDir(searchParams.get("site"));
  if (!dir) return json({ error: "invalid site" }, 400);

  const [memory, context, stateRaw] = await Promise.all([
    fs.readFile(path.join(dir, "memory.md"), "utf-8").catch(() => null),
    fs.readFile(path.join(dir, "context.md"), "utf-8").catch(() => null),
    fs.readFile(path.join(dir, "state.json"), "utf-8").catch(() => null),
  ]);

  let state: MemoryState | null = null;
  if (stateRaw) {
    try {
      state = JSON.parse(stateRaw) as MemoryState;
    } catch {
      state = null; // corrupt/partial write — resume treats this as "no saved state"
    }
  }

  return json({ memory, context, state });
}

interface PostBody {
  site?: unknown;
  memory?: unknown;
  context?: unknown;
  state?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const denied = requireAuth(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as PostBody | null;
  const site = typeof body?.site === "string" ? body.site : null;
  const dir = siteDir(site);
  if (!dir) return json({ error: "invalid site" }, 400);

  await withSiteLock(site!, async () => {
    await fs.mkdir(dir, { recursive: true });

    const writes: Promise<void>[] = [];
    if (typeof body?.memory === "string") {
      writes.push(atomicWriteFile(path.join(dir, "memory.md"), body.memory));
    }
    if (typeof body?.context === "string") {
      writes.push(atomicWriteFile(path.join(dir, "context.md"), body.context));
    }
    if (body?.state !== undefined) {
      writes.push(atomicWriteFile(path.join(dir, "state.json"), JSON.stringify(body.state, null, 2)));
    }

    await Promise.all(writes);
  });

  return json({ saved: true });
}
