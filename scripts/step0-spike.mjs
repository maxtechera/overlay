// Step-0 spike (TECH-SPEC §1): multi-step tool loop via streamText THROUGH a byte-level
// pass-through proxy — validates proxy transparency + pinned ai@6 APIs + fullStream parts.
// Run: node --env-file=.env.local scripts/step0-spike.mjs
import http from "node:http";
import { streamText, tool, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// --- the pass-through proxy, exactly the shape of app/api/anthropic/[...p]/route.ts
const proxy = http.createServer(async (req, res) => {
  const body = await new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
  const upstream = await fetch(`https://api.anthropic.com${req.url.replace("/api/anthropic", "")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body,
  });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
  for await (const chunk of upstream.body) res.write(chunk); // stream bytes untouched
  res.end();
});
await new Promise((r) => proxy.listen(4601, r));

// --- the loop, exactly the shape of lib/agent.ts
const anthropic = createAnthropic({ apiKey: "proxied", baseURL: "http://localhost:4601/api/anthropic/v1" });
const seen = { types: new Set(), toolCalls: 0, toolResults: 0, textChunks: 0 };

const result = streamText({
  model: anthropic("claude-haiku-4-5"),
  system: "You are a test agent. Use the double tool when asked to double numbers.",
  messages: [{ role: "user", content: "Double 21, then double the result, then tell me both answers in one sentence." }],
  tools: {
    double: tool({
      description: "Double a number",
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => ({ result: n * 2 }),
    }),
  },
  stopWhen: stepCountIs(6),
});

let text = "";
for await (const p of result.fullStream) {
  seen.types.add(p.type);
  if (p.type === "text-delta") { seen.textChunks++; text += p.text ?? p.delta ?? ""; }
  if (p.type === "tool-call") { seen.toolCalls++; console.log("tool-call:", p.toolName, JSON.stringify(p.input)); }
  if (p.type === "tool-result") { seen.toolResults++; console.log("tool-result:", JSON.stringify(p.output)); }
  if (p.type === "error") console.log("ERROR PART:", p.error);
}
const responseMessages = (await result.response).messages;

console.log("\n--- VERDICT ---");
console.log("part types seen:", [...seen.types].join(", "));
console.log(`tool calls: ${seen.toolCalls} · tool results: ${seen.toolResults} · text chunks: ${seen.textChunks}`);
console.log("response.messages count:", responseMessages.length);
console.log("final text:", JSON.stringify(text.trim()));
console.log(
  seen.toolCalls >= 2 && seen.toolResults >= 2 && text.includes("84")
    ? "✅ STEP-0 GREEN: multi-step tool loop streamed through the pass-through proxy"
    : "❌ STEP-0 RED — investigate before building"
);
proxy.close();
