/**
 * app/api/anthropic/[...p]/route.ts — TECH-SPEC §1
 *
 * Byte-level pass-through proxy to api.anthropic.com. Never parse or re-emit SSE
 * (protocol-translating proxies break multi-step tool streaming). The key is read ONLY
 * here, from .env.local, and never logged or echoed back to the client.
 *
 * Client provider (lib/agent.ts): createAnthropic({ apiKey: "proxied", baseURL: "/api/anthropic/v1" })
 * Path mapping: /api/anthropic/v1/messages -> https://api.anthropic.com/v1/messages
 */

export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ p: string[] }> }) {
  const { p } = await ctx.params;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Clean, structured error — never a hang. lib/agent.ts surfaces this in chat.
    return new Response(JSON.stringify({ error: { message: "ANTHROPIC_API_KEY is not set" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const upstream = await fetch(`https://api.anthropic.com/${p.join("/")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: await req.text(), // buffer request (small); response stays streamed
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
