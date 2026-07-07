# TECH-SPEC — Overlay (companion to PRD.md)

Code-level contracts. A builder follows this file verbatim; PRD.md explains *why*, this file says
*exactly what*. Where this file shows code, it is the intended shape — adapt names only if the
compiler forces it, never the architecture.

---

## 0. Pinned versions & API facts (verified 2026-07, do not "upgrade")

- `ai@6` + `@ai-sdk/anthropic@3` — **both majors pinned, empirically verified 2026-07-07**
  (`ai@6.0.220` + `@ai-sdk/anthropic@3.x` in package.json). Do NOT install ai@7, and do NOT
  install @ai-sdk/anthropic@4 (it implements spec v4 for ai@7 and throws
  `UnsupportedModelVersionError` under ai@6 — we hit this; the fix is the @3 pin).
- Tool definition: `tool({ description, inputSchema: z.object({...}), execute })` —
  **`inputSchema`, not `parameters`** (v4 name; a smaller model will hallucinate it).
- Loop: `streamText({ model, system, messages, tools, stopWhen: stepCountIs(16) })`. We use
  `streamText` + our own message array, NOT `ToolLoopAgent` and NOT `useChat` — we need custom
  transcript rendering and in-process approval.
- Stream parts on `result.fullStream` — **observed in the step-0 run**: `start`, `start-step`,
  `tool-input-start`, `tool-input-delta`, `tool-input-end`, `tool-call` (payload: `.toolName`,
  `.input`), `tool-result` (payload: `.output`), `finish-step`, `text-start`, `text-delta`,
  `text-end`, `finish`. Handle the four that matter (`text-delta`, `tool-call`, `tool-result`,
  `error`); ignore the rest silently. `text-delta` carried `.text` in our run — read
  `(p as any).text ?? (p as any).delta` (vercel/ai#8756).
- Models: agent `anthropic("claude-sonnet-4-6")` · COM + brief `anthropic("claude-haiku-4-5")`.
- UI: **Tailwind v4 + shadcn/ui + AI Elements** (`npx ai-elements@latest add conversation
  message response tool prompt-input suggestion`) — components land in
  `components/ai-elements/` as editable source. `MessageList` maps ChatBlocks → them:
  `text` → `Message`/`Response` · `tool` → `Tool` (ToolHeader/Input/Output) · goal chips →
  `Suggestion` · `proposal`/`brief`/`component` → hand-built on shadcn primitives. Feed props
  from the zustand store; do not wire `useChat`.
- Approval: in-process awaited promise (§4). Do NOT use `needsApproval` (that flow assumes
  useChat server round-trips).

## 1. Anthropic proxy — `app/api/anthropic/[...p]/route.ts` (complete)

Byte-level pass-through; never parse or re-emit SSE (protocol-translating proxies break
multi-step tool streaming).

```ts
export const maxDuration = 300;
export async function POST(req: Request, ctx: { params: Promise<{ p: string[] }> }) {
  const { p } = await ctx.params;
  const upstream = await fetch(`https://api.anthropic.com/${p.join("/")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: await req.text(),          // buffer request (small); response stays streamed
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
}
```

Client provider (in `lib/agent.ts`):

```ts
const anthropic = createAnthropic({ apiKey: "proxied", baseURL: "/api/anthropic/v1" });
```

`apiKey` must be a non-empty string (SDK asserts); the proxy overwrites it. Path mapping:
`/api/anthropic/v1/messages` → `https://api.anthropic.com/v1/messages`.

**Step 0 spike: ✅ DONE, GREEN** (`scripts/step0-spike.mjs`, 2026-07-07) — 2-step tool loop
streamed through this exact proxy shape. Keep the script as a regression check; no browser-side
re-spike needed (build step 5 exercises it in the real page anyway).

## 2. Ingest — `app/api/ingest/route.ts`

1. Validate `?url=` (http/https only; reject private IPs/localhost — cheap SSRF guard).
2. `fetch(url, { headers: { "user-agent": CHROME_UA, accept: "text/html" }, redirect: "follow" })`.
3. Reject: non-2xx, content-type not html, body > 5 MB, or bot-wall markers
   (`cf-chl`, `challenge-platform`, `Just a moment`) → `422 { reason: "bot-wall" | ... }`.
4. Parse (`node-html-parser`), then:
   - remove `<meta http-equiv="Content-Security-Policy">`
   - remove third-party experimentation scripts by src substring
     (`optimizely|vwo|convert.com|abtasty|omniconvert`) — competing DOM mutators (PRD §4.1)
   - inject `<base href="{finalUrl}">` as FIRST child of `<head>` (resolves every relative and
     root-relative URL — no manual absolutization)
   - inject `<script>{compiled runtime}</script>` before `</body>`
5. Respond `text/html`; do NOT set `X-Frame-Options` or CSP.

Runtime compilation: keep `lib/runtime.ts` dependency-free; build to a string via
`esbuild --bundle --format=iife` at dev time (a `predev` script writing `lib/runtime.built.js`),
imported by the route as a string. No runtime imports from the app — it runs inside someone
else's page.

## 3. Iframe protocol + host bridge

```ts
// lib/protocol.ts — every message carries requestId; runtime echoes it back
type ParentMsg =
  | { t: "extract" }
  | { t: "overlay"; on: boolean }
  | { t: "apply-op"; opId: string; op: Op }
  | { t: "revert-op"; opId: string };
type RuntimeMsg =
  | { t: "ready" }
  | { t: "schema"; nodes: PageNode[]; seo: PageBrief["seo"] }
  | { t: "op-applied"; opId: string; ok: boolean; error?: string;
      warnings?: string[] }                        // M3+: e.g. "overflow: scrollW 812 > clientW 640"
  | { t: "op-wiped"; opId: string }                 // unsolicited, no requestId
  | { t: "op-reverted"; opId: string }
  | { t: "selected"; nodeId: string };              // unsolicited
```

`IframeHost` keeps `pending = new Map<string, (msg) => void>()`; exposes
`sendToIframe(msg): Promise<RuntimeMsg>` (attach `requestId: nanoid()`, resolve on echo,
30s reject → tools convert to `{ error }` strings). Unsolicited messages dispatch straight to
stores. Both sides `postMessage(msg, window.location.origin)` — same-origin by construction.

## 4. Tools — `lib/tools.ts` (the MVP belt: five below + `save_memory` from §11 at M4)

```ts
export const makeTools = (deps: { send: SendToIframe; stores: Stores }) => ({
  list_components: tool({
    description: "Outline of every identified component: id, path, type, text preview.",
    inputSchema: z.object({}),
    execute: async () => deps.stores.schema.outline(),   // [{id,path,type,preview}] — store lookup, no iframe hop
  }),
  read_component: tool({
    description: "Full detail of one component: slots, classes, rect.",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => deps.stores.schema.node(id) ?? { error: "unknown id" },
  }),
  apply_op: tool({
    description: "Propose a content change. Requires human approval; may be rejected.",
    inputSchema: z.object({
      target: z.string(),
      slots: z.record(z.object({ text: z.string().optional(), href: z.string().optional(),
                                 src: z.string().optional(), alt: z.string().optional() })),
      rationale: z.string(),
    }),
    execute: async (op) => {
      const opId = nanoid();
      const approved = await deps.stores.approvals.request(opId, op);  // ProposalCard resolves
      if (!approved) return { applied: false, reason: "rejected by user" };  // resolve, NEVER throw
      const res = await deps.send({ t: "apply-op", opId, op: { op: "update-content", ...op } });
      deps.stores.variant.record(opId, op, res.ok);
      return res.ok ? { applied: true, opId } : { applied: false, reason: res.error };
    },
  }),
  revert_op: tool({
    description: "Undo a previously applied op.",
    inputSchema: z.object({ opId: z.string() }),
    execute: async ({ opId }) => deps.send({ t: "revert-op", opId }),
  }),
  create_variant: tool({
    description: "Save a recommendation as a new named variant and make it active. Use one variant per distinct angle/hypothesis. Optionally aim it at a brief segment.",
    inputSchema: z.object({ name: z.string().max(60), goal: z.string().optional(),
                            segment: z.string().optional() }),
    execute: async ({ name, goal, segment }) => deps.stores.variants.create(name, goal, segment),
  }),
  score_variant: tool({
    description: "Independent conversion rating of the ACTIVE variant vs control.",
    inputSchema: z.object({}),
    execute: async () => scoreVariant(deps.stores.snapshotForScoring()),   // §7, active variant
  }),
});
```

## 5. Agent loop — `lib/agent.ts`

```ts
export async function runTurn(userText: string) {
  const chat = useChatStore.getState();
  chat.pushUser(userText);
  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system: buildSystem(),                       // rebuilt EVERY turn — brief edits take effect
    messages: [...chat.messages, { role: "user", content: userText }],
    tools: makeTools(deps),
    stopWhen: stepCountIs(16),
  });
  for await (const p of result.fullStream) {
    switch (p.type) {
      case "text-delta": chat.appendText((p as any).text ?? (p as any).delta); break;
      case "tool-call":  chat.openTool(p.toolCallId, p.toolName, (p as any).input); break;
      case "tool-result": chat.closeTool(p.toolCallId, (p as any).output); break;
      case "error": chat.pushError(String((p as any).error)); break;
    }                                            // unknown types: ignore
  }
  // commitTurn appends BOTH the user message and the assistant/tool messages to chat.messages —
  // response.messages does not include the user turn.
  chat.commitTurn({ role: "user", content: userText }, (await result.response).messages);
}
```

`buildSystem()` = AGENT_SYSTEM template (§8) interpolating url, component outline, brief JSON
(when present), active goal. The brief is **never** a chat message. Batch `appendText` behind
`requestAnimationFrame`. First turn is triggered by the URL message: UI calls ingest + extract
first, then `runTurn("[page loaded] …")` — the agent does not call ingest itself (keeps M1 to
read/apply tools; extraction is deterministic, not agent work).

## 6. Runtime — `lib/runtime.ts` (iframe side, dependency-free)

**Boot:** on `readyState === "complete"` + 500 ms settle → post `ready`. Install click
interceptor: `document.addEventListener("click", e => { const a = e.target.closest("a"); if (a) e.preventDefault(); }, true)`
(with `<base>` set, any real click navigates the preview away). Also forward clicks on
identified nodes → `selected`.

**Detection ladder (deterministic, pure functions — PRD §4.2):** classification tries, in
order: (1) `profiles.ts` per-hostname overrides (`{ "posthog.com": { hero: "<selector>", … } }`
— the sanctioned demo cheat, one file, deletable per site); (2) framework fingerprints —
detect once (`MuiButton-root|__NEXT_DATA__|class~="max-w-"` etc.), then MUI class names map
straight to types (`MuiCard-root` → card, `MuiTypography-h1` → text/h1) and Tailwind patterns
mark bands (`py-16+` sections, `container/max-w-* mx-auto` wrappers, `text-4xl+` headings,
repeated grid/flex children → collection); (3) semantic HTML; (4) computed-style/layout
heuristics. Every node gets `via: "profile"|"framework"|"semantic"|"layout"`, shown in the
overlay label in dev. Extraction functions are pure (DOM in → PageNode[] out) and run against
**saved fixture HTML** of the test set (capture via the spike server) in the M5 smoke evals —
fully deterministic, no network.

**Leaf-node rule (resolves the slots-vs-nodes ambiguity):** `text` / `media` / `link` PageNodes
exist ONLY for orphan content that no container claimed. Content inside a detected container is
represented as that container's **slots**, not as separate nodes. `list_components` outlines
containers (hero/section/card/collection) plus orphan leaves — never a node per paragraph.

**Hero extraction (M1):**
1. Candidates: `h1, h2, [role=heading]`, visible (`offsetParent !== null`), top edge within
   1.2 × viewport height.
2. Prominence: largest computed `font-size`; tie → earliest in document order.
3. Hero container: climb ancestors until `width ≥ 60% viewport && height ≥ 200px`; stop before
   `body`; fallback to the heading's `section`/`header` ancestor.
4. Slots: `headline` (the heading) · `subhead` (next visible text ≤ 300 chars inside hero,
   optional) · `cta` (first `<a>`/`<button>` with visible text inside hero: text + href).
5. `SelectorRef`: `#id` if present → unique `[data-*]` → structural path; fingerprint =
   normalized first 40 chars of headline. **Register `Element` in a module-level
   `Map<nodeId, Element>` — all in-session ops resolve via this map; selectors are only for
   re-attach after reload and for export.**
6. No candidate → `schema` with `nodes: []` (a valid result; the agent must say so).

SEO: read `document.title`, meta description, `og:*`, h1–h3 outline off the live DOM; include in
the `schema` message.

**Node facts (M2, computed at extract — all from computed style/layout, no LLM):**
`lines` = round(rect.height / computed line-height) for text nodes · `fontPx` = computed
font-size · `contrast` = WCAG relative-luminance ratio of computed color vs effective background
(walk ancestors until a non-transparent background-color; skip if a background-image is in the
chain — report `contrast: undefined`, don't fake it) · `truncated` = overflow hidden +
text-overflow ellipsis, or scrollWidth > clientWidth · `focusable` = tabIndex ≥ 0 / intrinsic ·
`missingAlt` = media without alt/aria-label. **ADA audit** = deterministic rollup over facts:
contrast < 4.5 (AA, normal text) or < 3 (≥24px) · missingAlt · heading-level jumps in the
outline · CTA not focusable. Emitted as `{ path, issue }[]` with the schema; the brief renders
it verbatim (the LLM never invents a11y findings — it only narrates the computed list).
**M3 warn-only regression checks** re-compute the target's facts after apply and add `warnings`
to `op-applied` on: overflow growth · `lines` increase · contrast falling below AA · alt lost.

**Overlay:** drawn **inside the iframe** (parent-side boxes drift on scroll). One
`position:absolute` container appended to `body` at the page's coordinate space
(`getBoundingClientRect() + scrollY`), `pointer-events: none`, 2px outline + small label chip
per node, `z-index: 2147483646`. Recompute on `resize` only (absolute coords scroll naturally).

**apply-op:** element from the map (absent → `{ ok: false, error: "refind-failed" }`); per slot
set `textContent` / `href` / `src`+`alt`; store `{ opId, el, prevSlots }` for revert. Never touch
classes or structure. **Overflow warn (M3, warn-only):** after apply, if `scrollWidth >
clientWidth` or `scrollHeight > clientHeight` grew on the target or its parent vs pre-apply →
include a `warnings` entry in `op-applied`; UI shows it on the op's card; the agent sees it in
the tool result. No retries, no blocking — the full verify loop is M7. **Wipe detection:** 1 s
after apply, if `el.isConnected === false` or textContent ≠ applied value → post `op-wiped`
(unsolicited). **revert-op:** restore `prevSlots`.

## 7. COM — `lib/com.ts` (isolation rule: imports NOTHING from agent.ts or stores)

```ts
// SlotSnapshot = { path: string; slots: Record<string, string> } — one entry per CHANGED node.
export async function scoreVariant(input: {
  brief: PageBrief | null; goal: string;
  control: SlotSnapshot[]; variant: SlotSnapshot[];   // before/after of changed nodes only
}): Promise<ComScore> {
  const { object } = await generateObject({
    model: anthropic("claude-haiku-4-5"),
    schema: z.object({
      control: z.number().min(0).max(1), variant: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1), reasons: z.array(z.string()).max(4),
    }),
    system: COM_SYSTEM, prompt: JSON.stringify(input),
  });
  return { ...object, delta: object.variant - object.control };
}
```

**Scores control AND variant — the delta is the story** (unanchored single scores cluster ~0.7
and read as arbitrary). The agent receives only this JSON via the tool result.

## 8. Prompts — `lib/prompts.ts` (final text, tune only against the §10 test set)

```
AGENT_SYSTEM =
You are Overlay, a conversion-optimization agent working on a live webpage you do not own.
Page: {url}
Components:
{outline}          ← "id · path · type · text preview", one per line; "NONE IDENTIFIED" if empty
{briefSection}     ← "Page Brief (human-approved): {json}" | omitted in M1
Active goal: {goal | "none stated — infer a sensible one and say what you chose"}

Rules:
- Explore before changing: read_component anything you intend to modify.
- Changes are ops on detected components' slots only. You cannot add or restructure elements.
- Propose few, high-conviction changes tied to the ICP, missed pain points, unhandled
  objections, or the goal. Explain each in one sentence of rationale.
- apply_op requires human approval. If rejected, ask for direction; do not re-propose the same op.
- Respect node facts as constraints: keep line counts (a 2-line headline stays ≤2 lines), never
  degrade contrast or accessibility. ADA findings in the brief are variant opportunities —
  propose fixes.
- After changing the variant, call score_variant and report the delta honestly — including when
  it is negative.
- Never claim a change is applied unless the tool result said applied: true.
- If no components were identified, say so plainly and stop.

COM_SYSTEM =
You are an independent conversion-rating model. Input: a page's conversion brief (may be null),
a goal, and before/after content for the changed components. Rate control and variant separately
(0–1) for how likely each is to achieve the goal for this audience. Judge only what you see; do
not assume the variant is better because it is newer. Reasons: concrete, ≤4, terse.

BRIEF_PROMPT (M2, generateObject with the PageBrief schema, haiku):
Compose a conversion brief for this page from its extracted content and SEO data. Every field
must be grounded in what the page actually says; write "unknown" rather than inventing. Input:
{seo + all text slots by path}
```

## 9. Stores — `lib/store.ts` (zustand, exact shapes)

```ts
session:  { url; status: "idle"|"ingesting"|"extracting"|"ready"|"error"; error?;
            brief: PageBrief | null; goal: string; setGoal; patchBrief }
schema:   { nodes: Record<string, PageNode>; order: string[]; outline(); node(id) }
variants: { list: Variant[]; activeId: "control" | string; create(name, goal?, segment?);
            setActive(id) }      // setActive = revert all applied ops → replay target's list;
                                 // ops always store prevSlots vs CONTROL, so replay is exact
// Thumbnails (M3, best-effort): parent runs html2canvas against iframe.contentDocument.body
// (same-origin) on first score of a variant; try/catch → styled fallback card. Runtime stays
// dependency-free — html2canvas lives in the PARENT, reaching into the frame.
chat:     { blocks: ChatBlock[]; messages: ModelMessage[]; streaming: boolean;
            pushUser; appendText; openTool; closeTool; pushError;
            commitTurn(userMsg, responseMsgs) }   // appends user + assistant/tool to messages
approvals:{ request(opId, op): Promise<boolean>; resolve(opId, approved) }   // Map<opId, resolver>

type ChatBlock =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "tool"; toolCallId: string; name: string; input: unknown; output?: unknown }
  | { kind: "proposal"; opId: string; op: Op; score?: ComScore;
      status: "pending" | "approved" | "rejected" }
  | { kind: "brief" } | { kind: "error"; text: string };
```

`MessageList` = switch on `block.kind` → Text / ToolCallRow / ProposalCard / BriefArtifact /
Error. `apply_op`'s tool-call part opens a `proposal` block (not a `tool` block) — match on
`toolName === "apply_op"`.

## 10. UX contracts

**Latency choreography (no dead air):** URL sent → preview iframe starts loading immediately
(skeleton) → page paints → overlay boxes appear (extraction done) → agent text streams. Each
stage visible within ~2 s of the previous. The brief (M2) streams as `BriefArtifact` fields fill.

**Goal chips:** `brief.suggestedGoals` render as clickable chips under the BriefArtifact; click
→ `session.setGoal`; default = first suggestion. The active goal shows in the composer as a
removable chip.

**Preview→chat:** click on an identified node → `selected` → composer gains a reference chip
(`hero.headline`); sending prepends `[re: hero.headline]` to the user text.

**Demo test set** (tune against these ONLY): `posthog.com` · `maxtechera.dev` (tier 2 —
hydrated Next.js) · `astro.build`. Failure-lap site: `linear.app` (bot-walled — validated 422
→ clean error path).

**✅ Proxy fidelity VALIDATED 2026-07-07** (`scripts/proxy-spike.mjs` + `scripts/spike-shots.mjs`,
screenshots in `scripts/shots/`): test-set sites fetched (no bot walls) and rendered
near-pixel-perfect through fetch + strip-CSP-meta + `<base href>` + same-origin serve; injected
script executed in-iframe (`marker=1`) with `h1` readable from the parent frame. Known blemish: one broken avatar image on maxtechera.dev (next/image edge case) —
cosmetic. Hard part #1's remaining unknown is only the *AI-loop* spike (step 0), not ingest.

## 11. Site memory (M4, in the MVP) — file storage, Claude Code patterns

**Storage** — one folder per site, written by a trivial API route (server fs, demo-grade):

```
.memory/<hostname>/memory.md    # agent-curated durable knowledge — injected every turn
.memory/<hostname>/state.json   # app-managed, full extraction + decisions:
                                # { schema: { nodes: PageNode[], extractedAt },  // snapshot
                                #   seo: PageBrief["seo"],
                                #   brief: PageBrief, goal: string,
                                #   variants: Variant[],          // ALL saved variants w/ scores
                                #   verdicts: { opId, approved, reason?, at }[] }
```

Save triggers: after extraction (schema+seo), after brief generation/edit, after every
approve/reject, after every score — fire-and-forget POST, no save button.

**Route** — `app/api/memory/route.ts`:
- `GET  ?site=<hostname>` → `{ memory: string | null, state: State | null }`
- `POST { site, memory? , state? }` → writes whichever is present, `mkdir -p` the folder.
- Path safety: `site` must match `/^[a-z0-9.-]+$/i` after `new URL(url).hostname` — reject
  anything else (no traversal). `.memory/` is gitignored.

**Tool** (added to §4's belt):

```ts
save_memory: tool({
  description: "Replace the site memory document. Use for durable learnings only (taste rules, do-not-touch, what worked). Keep it under 100 lines; curate, don't append forever.",
  inputSchema: z.object({ content: z.string().max(8000) }),
  execute: async ({ content }) => { await postMemory({ memory: content }); return { saved: true }; },
}),
```

The agent receives the current `memory.md` in `buildSystem()` under a `Site memory:` heading
(empty → "none yet"). App auto-appends approve/reject verdicts with reasons to `state.json`
(structured, replayable for evals) AND surfaces the last few to the agent in the system prompt —
the agent decides what graduates into `memory.md` via `save_memory`. Same division as Claude
Code: transcript vs CLAUDE.md.

**Resume flow:** URL submitted → `GET /api/memory` first → hydrate brief, goal, ops, verdicts,
seo from state.json (LLM/human artifacts are never regenerated). Extraction still runs against
the fresh DOM (free, deterministic, and the live element map requires it) — then **diff fresh
schema vs saved snapshot by path+fingerprint**: unchanged → carry the node's history; moved or
missing → mark stale in the outline ("pricing section changed since last session") so the agent
and user see it rather than trust it. First reply acknowledges the resume ("Back on posthog.com —
3 learnings on file, last variant scored +0.12, hero unchanged"). Ops are NOT auto-reapplied;
the op list shows "from last session" with a re-apply action (valid only for non-stale
targets).

## 12. Export (M5, in the MVP) — the variant as a deployable A/B script

`lib/export.ts` builds one self-contained snippet from the active variant:

```
<script>
/* overlay A/B — generated {no timestamps in the generator: use the variant id} */
(function () {
  var OPS = [/* the variant's applied ops, JSON: {target: SelectorRef, slots} */];
  var KEY = "overlay-ab-<variantId>";
  var MODE = "ab";                    // or "segment", with SIGNAL = {param,value}|{device}|{referrer}
  var bucket;
  if (MODE === "segment") {
    bucket = /* signal matches? */ "variant" /* else */ ;   // deterministic rule, no persistence needed
  } else {
    bucket = localStorage.getItem(KEY) ||
      (localStorage.setItem(KEY, Math.random() < 0.5 ? "control" : "variant"),
       localStorage.getItem(KEY));
  }
  if (location.hash === "#overlay-force-variant") bucket = "variant";   // console/demo path
  window.__overlayVariant = bucket;
  document.documentElement.setAttribute("data-overlay-variant", bucket);
  if (bucket !== "variant") return;
  OPS.forEach(function (op) { /* re-find: querySelector(css) + normalized-fingerprint check;
    mismatch → console.warn("[overlay] drop " + op.target.css) and skip — NEVER guess.
    Apply on DOMContentLoaded if document is still loading. */ });
})();
</script>
```

Rules: dependency-free IIFE, <2 KB unminified target; re-find uses `SelectorRef` + fingerprint
against the ORIGINAL page (valid there — TECH-SPEC hard part #5); `update-content` slots only in
MVP (text/href/src/alt). The Export block in chat offers: **a variant picker** (any saved variant; KEY embeds its id so concurrent tests don’t collide) · **Copy `<script>` tag** ·
**Copy console version** (same code, bucket forced to `variant`) · a one-paragraph doc note on
reading `window.__overlayVariant` / `data-overlay-variant` from GA4/PostHog and on edge
injection (rewrite `</body>` in a CF Worker / Vercel Edge Middleware — same snippet, no extra
code). We never measure conversions ourselves.

## 13. Password gate (public deployment)

The app deploys publicly behind a **shared password**. ~30 lines, no library:

- `APP_PASSWORD` env (Vercel). **Unset → gate disabled** (local dev unchanged).
- `POST /api/auth { password }` → constant-time compare → sets httpOnly, secure, SameSite=Lax
  cookie `overlay-auth` = hex(SHA-256(APP_PASSWORD + "overlay-v1")). 401 otherwise.
- A shared `requireAuth(req)` guard at the top of EVERY other `app/api/**` route: recompute the
  hash, compare to the cookie, 401 on mismatch. The key never leaves the server either way.
- Client: on any 401, show a single password field over the app; on success, reload state.
- The **exported snippet is exempt by design** — self-contained, zero API calls, runs on
  third-party sites. (M10's dynamic serving route will need its own public story — noted in
  #11, not solved now.)
- Keep the failed-attempt log line; no rate limiting beyond Vercel defaults for now (shared
  password + no key exposure keeps blast radius at "they can chat on our dime once inside").

## 14. Done-when (maps to PRD acceptance)

- ~~Step 0 spike~~ **GREEN 2026-07-07** (`scripts/step0-spike.mjs`): 2-step tool loop
  (tool-call → tool-result → tool-call → tool-result → text) streamed through the byte-level
  pass-through proxy; `response.messages` (5) appended cleanly. Model: claude-haiku-4-5.
- M1 tick on all three test URLs *or* an honest in-chat failure ("bot wall", "no hero found").
- Approve → visible change < 500 ms; Reject → agent acknowledges and asks direction.
- Kill the dev API key in `.env.local` → chat shows a clean error, not a hang.
- ~~Proxy fidelity check~~ **done 2026-07-07: test-set sites render + inject + extract (§10).**
- M4: reject a proposal with a reason → next proposal respects it → close tab, reopen, same URL
  → brief loads from disk, agent references the learning, `.memory/<site>/memory.md` is a real
  file you can open on screen.
- M5: exported snippet pasted in the console on the ORIGINAL live page (with
  `#overlay-force-variant`) applies the variant; as a script tag, visitors bucket 50/50 and
  `window.__overlayVariant` + `data-overlay-variant` read correctly; fingerprint mismatch →
  warn + skip, never guess.
