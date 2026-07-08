/**
 * lib/runtime.ts — iframe-side runtime, DEPENDENCY-FREE
 * Built to a string via `predev`/`prebuild` (scripts/build-runtime.mjs → lib/runtime.built.js)
 * Injected before </body> by /api/ingest.
 */

type NodeType = "hero" | "section" | "card" | "collection" | "text" | "media" | "link";

interface SelectorRef {
  css: string;
  fingerprint?: string;
}

interface PageNode {
  id: string;
  path: string;
  type: NodeType;
  variant?: "h1" | "h2" | "h3" | "p" | "label";
  selector: SelectorRef;
  rect: { x: number; y: number; w: number; h: number };
  slots: Record<
    string,
    { kind: "text" | "media" | "link"; text?: string; href?: string; src?: string; alt?: string }
  >;
  facts?: {
    lines?: number;
    fontPx?: number;
    contrast?: number;
    truncated?: boolean;
    focusable?: boolean;
    missingAlt?: boolean;
  };
  classes: string[];
  children?: string[];
  via?: "profile" | "framework" | "semantic" | "layout";
}

type Op = {
  op: "update-content";
  target: string;
  slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }>;
  rationale: string;
};

// ── module-level element map (in-session ops resolve here, not via re-query) ──
const elementMap = new Map<string, Element>();

// prevApplied: opId → { targetNodeId, prevSlots }
const prevApplied = new Map<
  string,
  {
    targetNodeId: string;
    prevSlots: Record<string, { text?: string; href?: string; src?: string; alt?: string }>;
  }
>();

// ── overlay container (drawn inside iframe) ──
let overlayContainer: HTMLDivElement | null = null;
let overlayOn = false;
let lastNodes: PageNode[] = [];

// ── counter for node ids ──
let nodeCounter = 0;

// ── postMessage helper ──
function post(msg: Record<string, unknown>): void {
  window.parent.postMessage(msg, "*");
}

// ── click interceptor: prevent any <a> from navigating the preview away ──
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as Element).closest("a");
    if (a) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);

// ── forward clicks on identified nodes → selected ──
document.addEventListener(
  "click",
  (e) => {
    for (const [nodeId, el] of elementMap) {
      // Only top-level node ids (no dots)
      if (nodeId.includes(".")) continue;
      if (el.contains(e.target as Node) || el === e.target) {
        post({ t: "selected", nodeId });
        return;
      }
    }
  },
  true
);

// ── build SelectorRef for an element ──
function buildSelector(el: Element): SelectorRef {
  if (el.id) {
    return { css: `#${CSS.escape(el.id)}`, fingerprint: normText(el.textContent ?? "") };
  }
  for (const attr of el.getAttributeNames()) {
    if (attr.startsWith("data-")) {
      const val = el.getAttribute(attr);
      if (val && document.querySelectorAll(`[${attr}="${CSS.escape(val)}"]`).length === 1) {
        return {
          css: `[${attr}="${CSS.escape(val)}"]`,
          fingerprint: normText(el.textContent ?? ""),
        };
      }
    }
  }
  const path = buildStructuralPath(el);
  return { css: path, fingerprint: normText(el.textContent ?? "") };
}

function buildStructuralPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(cur) + 1;
        parts.unshift(`${tag}:nth-of-type(${idx})`);
      } else {
        parts.unshift(tag);
      }
    } else {
      parts.unshift(tag);
    }
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

function normText(t: string): string {
  return t.replace(/\s+/g, " ").trim().slice(0, 40);
}

// ── visibility check ──
function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
    return false;
  const h = el as HTMLElement;
  if (h.offsetParent === null && style.position !== "fixed" && style.position !== "sticky")
    return false;
  return true;
}

// ── get element for a slot within a node ──
function getSlotElement(
  nodeId: string,
  slotName: string,
  container: Element
): Element | null {
  const subKey = `${nodeId}.${slotName}`;
  if (elementMap.has(subKey)) return elementMap.get(subKey)!;
  if (slotName === "headline") return container.querySelector("h1, h2, h3, [role=heading]");
  if (slotName === "cta") return container.querySelector("a, button");
  if (slotName === "subhead") {
    const heading = container.querySelector("h1, h2, h3");
    if (heading) {
      let sib = heading.nextElementSibling;
      while (sib) {
        if (isVisible(sib)) return sib;
        sib = sib.nextElementSibling;
      }
    }
  }
  return null;
}

// ── hero detection (TECH-SPEC §6) ──
function detectHero(): PageNode | null {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 1. Candidates: h1, h2, [role=heading], visible, top edge within 1.2× viewport
  const seen = new Set<Element>();
  const candidates: HTMLElement[] = [];
  const headingSelectors = ["h1", "h2", "[role=heading]"];
  for (const sel of headingSelectors) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (isVisible(el) && rect.top + window.scrollY < vh * 1.2) {
        candidates.push(el);
      }
    });
  }

  if (candidates.length === 0) return null;

  // 2. Prominence: largest computed font-size; tie → earliest in document order
  let best: HTMLElement = candidates[0];
  let bestPx = parseFloat(window.getComputedStyle(best).fontSize) || 0;

  for (let i = 1; i < candidates.length; i++) {
    const el = candidates[i];
    const px = parseFloat(window.getComputedStyle(el).fontSize) || 0;
    if (px > bestPx) {
      bestPx = px;
      best = el;
    }
    // tie → earliest: candidates already in DOM order since querySelectorAll is ordered
  }

  const headingEl = best;

  // 3. Hero container: climb ancestors until width ≥ 60% viewport && height ≥ 200px
  let container: Element = headingEl;
  let cur: Element | null = headingEl.parentElement;
  while (cur && cur !== document.body) {
    const r = cur.getBoundingClientRect();
    if (r.width >= vw * 0.6 && r.height >= 200) {
      container = cur;
      break;
    }
    const tag = cur.tagName.toLowerCase();
    if ((tag === "section" || tag === "header") && container === headingEl) {
      container = cur; // fallback accumulator
    }
    cur = cur.parentElement;
  }

  const containerRect = container.getBoundingClientRect();
  const nodeId = `n${++nodeCounter}`;

  // Register container in element map
  elementMap.set(nodeId, container);
  // Register heading
  elementMap.set(`${nodeId}.headline`, headingEl);

  // 4. Slots
  const slots: PageNode["slots"] = {};
  slots.headline = { kind: "text", text: headingEl.textContent?.trim() ?? "" };

  // subhead: next visible text ≤ 300 chars inside hero container
  const allText = container.querySelectorAll("p, h2, h3, span, div");
  for (const t of allText) {
    if (t === headingEl) continue;
    if (!isVisible(t)) continue;
    // Skip if it contains the heading
    if (t.contains(headingEl)) continue;
    const txt = t.textContent?.trim() ?? "";
    if (txt.length > 0 && txt.length <= 300) {
      slots.subhead = { kind: "text", text: txt };
      elementMap.set(`${nodeId}.subhead`, t);
      break;
    }
  }

  // cta: first <a>/<button> with visible text inside hero
  const ctaCandidates = container.querySelectorAll<HTMLElement>("a, button");
  for (const el of ctaCandidates) {
    if (!isVisible(el)) continue;
    const txt = el.textContent?.trim() ?? "";
    if (txt.length > 0) {
      const href = (el as HTMLAnchorElement).href ?? undefined;
      slots.cta = { kind: "link", text: txt, href };
      elementMap.set(`${nodeId}.cta`, el);
      break;
    }
  }

  // 5. SelectorRef
  const selector = buildSelector(container);

  // Facts
  const cs = window.getComputedStyle(headingEl);
  const fontPx = parseFloat(cs.fontSize) || undefined;
  const lineHeight = parseFloat(cs.lineHeight) || fontPx || 1;
  const headingRect = headingEl.getBoundingClientRect();
  const lines = fontPx && lineHeight ? Math.round(headingRect.height / lineHeight) || 1 : undefined;

  const node: PageNode = {
    id: nodeId,
    path: "hero",
    type: "hero",
    selector,
    rect: {
      x: containerRect.left + window.scrollX,
      y: containerRect.top + window.scrollY,
      w: containerRect.width,
      h: containerRect.height,
    },
    slots,
    facts: { lines, fontPx },
    classes: Array.from(container.classList),
    via: "semantic",
  };

  return node;
}

// ── SEO extraction ──
function extractSEO() {
  const og: Record<string, string> = {};
  document.querySelectorAll("meta[property^='og:']").forEach((m) => {
    const prop = m.getAttribute("property") ?? "";
    const content = m.getAttribute("content") ?? "";
    og[prop.replace("og:", "")] = content;
  });

  const headingOutline: { level: 1 | 2 | 3; text: string }[] = [];
  document.querySelectorAll("h1, h2, h3").forEach((h) => {
    const level = parseInt(h.tagName.replace("H", ""), 10) as 1 | 2 | 3;
    const txt = h.textContent?.trim() ?? "";
    if (txt) headingOutline.push({ level, text: txt });
  });

  return {
    title: document.title,
    metaDescription:
      (document.querySelector("meta[name=description]") as HTMLMetaElement | null)?.content ??
      undefined,
    og,
    headingOutline,
  };
}

// ── overlay drawing ──
function clearOverlay(): void {
  if (overlayContainer) {
    overlayContainer.remove();
    overlayContainer = null;
  }
}

function drawOverlay(nodes: PageNode[]): void {
  clearOverlay();
  if (!overlayOn || nodes.length === 0) return;

  overlayContainer = document.createElement("div");
  Object.assign(overlayContainer.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    pointerEvents: "none",
    zIndex: "2147483646",
  });
  document.body.appendChild(overlayContainer);

  for (const node of nodes) {
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "absolute",
      left: `${node.rect.x}px`,
      top: `${node.rect.y}px`,
      width: `${node.rect.w}px`,
      height: `${node.rect.h}px`,
      border: "2px solid #f97316",
      boxSizing: "border-box",
      pointerEvents: "none",
    });

    const label = document.createElement("div");
    Object.assign(label.style, {
      position: "absolute",
      top: "0",
      left: "0",
      background: "#f97316",
      color: "#0a0a0a",
      fontSize: "10px",
      fontFamily: "monospace",
      padding: "1px 5px",
      lineHeight: "1.4",
      whiteSpace: "nowrap",
    });
    label.textContent =
      `${node.path} · ${node.type}` + (node.via ? ` · ${node.via}` : "");

    box.appendChild(label);
    overlayContainer.appendChild(box);
  }
}

// ── apply op helper ──
function applySlots(
  nodeId: string,
  container: Element,
  slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }>,
  save: boolean
): Record<string, { text?: string; href?: string; src?: string; alt?: string }> {
  const prev: Record<string, { text?: string; href?: string; src?: string; alt?: string }> = {};

  for (const [slotName, slotValue] of Object.entries(slots)) {
    const targetEl = getSlotElement(nodeId, slotName, container);
    if (!targetEl) continue;

    if (save) {
      prev[slotName] = {
        text: targetEl.textContent ?? undefined,
        href: (targetEl as HTMLAnchorElement).href ?? undefined,
        src: (targetEl as HTMLImageElement).src ?? undefined,
        alt: (targetEl as HTMLImageElement).alt ?? undefined,
      };
    }

    if (slotValue.text !== undefined) targetEl.textContent = slotValue.text;
    if (slotValue.href !== undefined && "href" in targetEl)
      (targetEl as HTMLAnchorElement).href = slotValue.href;
    if (slotValue.src !== undefined && "src" in targetEl)
      (targetEl as HTMLImageElement).src = slotValue.src;
    if (slotValue.alt !== undefined && "alt" in targetEl)
      (targetEl as HTMLImageElement).alt = slotValue.alt;
  }

  return prev;
}

// ── message handler ──
window.addEventListener("message", (e) => {
  const msg = e.data as Record<string, unknown>;
  if (!msg || typeof msg.t !== "string") return;

  switch (msg.t) {
    case "extract": {
      const hero = detectHero();
      const seo = extractSEO();
      const nodes = hero ? [hero] : [];
      lastNodes = nodes;
      if (overlayOn) drawOverlay(nodes);
      post({ t: "schema", nodes, seo, requestId: msg.requestId });
      break;
    }

    case "overlay": {
      overlayOn = msg.on as boolean;
      if (overlayOn) {
        drawOverlay(lastNodes);
      } else {
        clearOverlay();
      }
      post({ t: "overlay-ack", on: overlayOn, requestId: msg.requestId });
      break;
    }

    case "apply-op": {
      const opId = msg.opId as string;
      const op = msg.op as Op;
      const requestId = msg.requestId as string;

      const el = elementMap.get(op.target);
      if (!el) {
        post({ t: "op-applied", opId, ok: false, error: "refind-failed", requestId });
        return;
      }

      const prev = applySlots(op.target, el, op.slots, true);
      prevApplied.set(opId, { targetNodeId: op.target, prevSlots: prev });

      // Wipe detection: 1s after apply
      const appliedTexts: Record<string, string> = {};
      for (const [slotName, slotValue] of Object.entries(op.slots)) {
        if (slotValue.text !== undefined) appliedTexts[slotName] = slotValue.text;
      }

      setTimeout(() => {
        if (!el.isConnected) {
          post({ t: "op-wiped", opId });
          return;
        }
        for (const [slotName, expectedText] of Object.entries(appliedTexts)) {
          const slotEl = getSlotElement(op.target, slotName, el);
          if (slotEl && slotEl.textContent !== expectedText) {
            post({ t: "op-wiped", opId });
            return;
          }
        }
      }, 1000);

      post({ t: "op-applied", opId, ok: true, requestId });
      if (overlayOn) drawOverlay(lastNodes);
      break;
    }

    case "revert-op": {
      const opId = msg.opId as string;
      const requestId = msg.requestId as string;
      const entry = prevApplied.get(opId);

      if (entry) {
        const el = elementMap.get(entry.targetNodeId);
        if (el) {
          applySlots(entry.targetNodeId, el, entry.prevSlots, false);
        }
        prevApplied.delete(opId);
      }

      post({ t: "op-reverted", opId, requestId });
      if (overlayOn) drawOverlay(lastNodes);
      break;
    }

    default:
      break;
  }
});

// ── boot: on readyState complete + 500ms settle → post ready ──
function boot(): void {
  setTimeout(() => {
    post({ t: "ready" });
  }, 500);
}

if (document.readyState === "complete") {
  boot();
} else {
  window.addEventListener("load", boot);
}
