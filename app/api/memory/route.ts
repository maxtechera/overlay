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

  await fs.mkdir(dir, { recursive: true });

  const writes: Promise<void>[] = [];
  if (typeof body?.memory === "string") {
    writes.push(fs.writeFile(path.join(dir, "memory.md"), body.memory, "utf-8"));
  }
  if (typeof body?.context === "string") {
    writes.push(fs.writeFile(path.join(dir, "context.md"), body.context, "utf-8"));
  }
  if (body?.state !== undefined) {
    writes.push(fs.writeFile(path.join(dir, "state.json"), JSON.stringify(body.state, null, 2), "utf-8"));
  }

  await Promise.all(writes);
  return json({ saved: true });
}
