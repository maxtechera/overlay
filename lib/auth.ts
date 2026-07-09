/**
 * lib/auth.ts — TECH-SPEC §13 password gate (server-only; ~30 lines, no library).
 *
 * APP_PASSWORD unset → gate disabled (local dev unchanged). When set, the app deploys behind
 * a shared password: POST /api/auth logs in and sets an httpOnly cookie; requireAuth() guards
 * every OTHER app/api/** route. The ANTHROPIC key never leaves the server either way — the gate
 * only decides whether a request is allowed to reach the proxy/ingest at all.
 *
 * The exported snippet (M5) is exempt by design: it's self-contained and makes zero API calls.
 */

import { createHash, timingSafeEqual } from "crypto";

export const AUTH_COOKIE = "overlay-auth";

/** hex(SHA-256(APP_PASSWORD + "overlay-v1")) — the value stored in the cookie. null = gate off. */
export function expectedHash(): string | null {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  return createHash("sha256").update(pw + "overlay-v1").digest("hex");
}

export function gateEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

/** hex(SHA-256(candidate + "overlay-v1")) — used to grade a login attempt without echoing the key. */
export function hashCandidate(candidate: string): string {
  return createHash("sha256").update(candidate + "overlay-v1").digest("hex");
}

/** Constant-time hex compare (length-guarded so timingSafeEqual never throws on mismatch). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True if the request carries a valid auth cookie (or the gate is disabled). */
export function isAuthed(req: Request): boolean {
  const expected = expectedHash();
  if (!expected) return true; // gate disabled
  const got = cookieValue(req, AUTH_COOKIE);
  return got !== null && safeEqualHex(got, expected);
}

/**
 * Guard for every protected app/api/** route. Returns a 401 Response to return immediately,
 * or null if the request may proceed. Never throws; never touches the ANTHROPIC key.
 */
export function requireAuth(req: Request): Response | null {
  if (isAuthed(req)) return null;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
