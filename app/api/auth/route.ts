/**
 * app/api/auth/route.ts — TECH-SPEC §13.
 * GET  → gate status { gateEnabled, authed } for the client AuthGate (never itself guarded).
 * POST → { password } → constant-time compare → set httpOnly cookie on success, 401 otherwise.
 * The password and key never leave the server; a failed attempt is logged (no rate limiting
 * beyond Vercel defaults — shared password + no key exposure keeps the blast radius small).
 */

import { AUTH_COOKIE, expectedHash, gateEnabled, hashCandidate, isAuthed, safeEqualHex } from "@/lib/auth";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export async function GET(req: Request) {
  if (!gateEnabled()) return json({ gateEnabled: false, authed: true });
  return json({ gateEnabled: true, authed: isAuthed(req) });
}

export async function POST(req: Request) {
  if (!gateEnabled()) return json({ authed: true }); // nothing to gate on
  const expected = expectedHash();
  if (!expected) return json({ authed: true });

  const { password } = (await req.json().catch(() => ({ password: "" }))) as { password?: unknown };
  const candidate = hashCandidate(typeof password === "string" ? password : "");

  if (!safeEqualHex(candidate, expected)) {
    console.warn("[auth] failed password attempt");
    return json({ error: "invalid password" }, 401);
  }

  return json({ authed: true }, 200, {
    "set-cookie": `${AUTH_COOKIE}=${expected}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
  });
}
