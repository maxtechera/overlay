/**
 * lib/runtime.ts — iframe-side runtime, DEPENDENCY-FREE (no npm packages; may import sibling
 * files like ./profiles, which esbuild inlines — see scripts/build-runtime.mjs).
 * Built to a string via `predev`/`prebuild` → lib/runtime.built.js. Injected before </body> by
 * /api/ingest.
 *
 * M2a (issue #2): full detection ladder, node facts, ADA audit, addressing. PRD §4.2 · TECH-SPEC §6.
 */

import { PROFILES } from "./profiles";

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

/** ADA audit finding — mirrors PageBrief["a11yAudit"] entry shape (PRD §5). */
interface Finding {
  path: string;
  issue: string;
}

type Op = {
  op: "update-content";
  target: string;
  slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }>;
  rationale: string;
};

// ── module-level element map (in-session ops resolve here, not via re-query) ──
// Two kinds of keys: "n12" (a node's own container/root element) and "n12.slotName" (the
// element backing one of that node's slots). Reset at the start of every "extract" — see the
// determinism note above extractPage().
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

// ── register a slot's backing element (uniform addressing for every node type) ──
function registerSlotEl(nodeId: string, slotName: string, el: Element): void {
  elementMap.set(`${nodeId}.${slotName}`, el);
}

function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
}

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

// ── WCAG contrast (facts + ADA audit) ──────────────────────────────────────────
// Pure, deterministic — no LLM. Walks ancestors for the effective background; if a
// background-image is found anywhere in that chain, contrast is UNKNOWN and reported as
// `undefined` — never faked (PRD §4.2 / TECH-SPEC §6).

function parseColor(str: string): { r: number; g: number; b: number; a: number } | null {
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
  if (parts.some((n) => Number.isNaN(n))) return null;
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts.length > 3 ? parts[3] : 1 };
}

function relLuminance(c: { r: number; g: number; b: number }): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  const la = relLuminance(a) + 0.05;
  const lb = relLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}

/** Walk `el` and its ancestors for the effective background. `"skip"` means "don't know, and
 *  don't guess" — a background-image sits somewhere in the chain before an opaque color does. */
function effectiveBackground(el: Element): { r: number; g: number; b: number } | "skip" {
  let cur: Element | null = el;
  while (cur) {
    const cs = window.getComputedStyle(cur);
    if (cs.backgroundImage && cs.backgroundImage !== "none") return "skip";
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a > 0) {
      if (bg.a >= 0.999) return { r: bg.r, g: bg.g, b: bg.b };
      // Partially transparent: compositing against an unknown further-back layer would be a
      // guess. Report unknown rather than fake a blended color.
      return "skip";
    }
    cur = cur.parentElement;
  }
  // No background found anywhere up to <html> — assume the page canvas default (white).
  return { r: 255, g: 255, b: 255 };
}

function computeContrast(el: Element): number | undefined {
  const cs = window.getComputedStyle(el);
  const fg = parseColor(cs.color);
  if (!fg) return undefined;
  const bg = effectiveBackground(el);
  if (bg === "skip") return undefined;
  return Math.round(contrastRatio(fg, bg) * 100) / 100;
}

// ── node facts (M2, TECH-SPEC §6) ──────────────────────────────────────────────

function textMetrics(el: Element): NonNullable<PageNode["facts"]> {
  const cs = window.getComputedStyle(el);
  const fontPx = parseFloat(cs.fontSize) || undefined;
  const lineHeightRaw = parseFloat(cs.lineHeight);
  const lineHeight =
    Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : (fontPx ?? 16) * 1.2;
  const rect = el.getBoundingClientRect();
  const lines = fontPx ? Math.max(1, Math.round(rect.height / lineHeight)) : undefined;
  const he = el as HTMLElement;
  const truncated =
    (cs.overflow === "hidden" && cs.textOverflow === "ellipsis") ||
    he.scrollWidth > he.clientWidth ||
    he.scrollHeight > he.clientHeight;
  const contrast = computeContrast(el);
  return { lines, fontPx, contrast, truncated };
}

function isFocusable(el: Element): boolean {
  const he = el as HTMLElement;
  return typeof he.tabIndex === "number" && he.tabIndex >= 0;
}

function mediaMissingAlt(el: Element): boolean {
  const alt = el.getAttribute("alt");
  const ariaLabel = el.getAttribute("aria-label");
  return !(alt && alt.trim().length > 0) && !(ariaLabel && ariaLabel.trim().length > 0);
}

// ── get element for a slot within a node (fallback heuristics for hero; every other node
// registers its slot elements directly at construction time, so elementMap hits first) ──
function getSlotElement(nodeId: string, slotName: string, container: Element): Element | null {
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

function findHeadingIn(container: Element, exclude?: Element): HTMLElement | null {
  const heads = container.querySelectorAll<HTMLElement>("h1, h2, h3, [role=heading]");
  for (const h of Array.from(heads)) {
    if (exclude && (h === exclude || exclude.contains(h))) continue;
    if (isVisible(h)) return h;
  }
  return null;
}

// ── hero detection (TECH-SPEC §6; M1) — extended with a ladder rung-1 profile check + full facts ──
function detectHero(hostname: string): PageNode | null {
  const profile = PROFILES[hostname];
  let container: Element | null = null;
  let headingEl: HTMLElement | null = null;
  let via: NonNullable<PageNode["via"]> = "layout";

  if (profile?.hero) {
    const el = document.querySelector<HTMLElement>(profile.hero);
    if (el && isVisible(el)) {
      container = el;
      headingEl = findHeadingIn(el);
      via = "profile";
    }
  }

  if (!container || !headingEl) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 1. Candidates: h1, h2, [role=heading], visible, top edge within 1.2× viewport
    const seen = new Set<Element>();
    const candidates: HTMLElement[] = [];
    for (const sel of ["h1", "h2", "[role=heading]"]) {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (isVisible(el) && rect.top + window.scrollY < vh * 1.2) candidates.push(el);
      });
    }
    if (candidates.length === 0) return null;

    // 2. Prominence: largest computed font-size; tie → earliest in document order
    let best = candidates[0];
    let bestPx = parseFloat(window.getComputedStyle(best).fontSize) || 0;
    for (let i = 1; i < candidates.length; i++) {
      const px = parseFloat(window.getComputedStyle(candidates[i]).fontSize) || 0;
      if (px > bestPx) {
        bestPx = px;
        best = candidates[i];
      }
    }
    headingEl = best;

    // 3. Hero container: climb ancestors until width ≥ 60% viewport && height ≥ 200px
    let cur: Element | null = best.parentElement;
    let climbed: Element = best;
    while (cur && cur !== document.body) {
      const r = cur.getBoundingClientRect();
      if (r.width >= vw * 0.6 && r.height >= 200) {
        climbed = cur;
        break;
      }
      const tag = cur.tagName.toLowerCase();
      if ((tag === "section" || tag === "header") && climbed === best) climbed = cur;
      cur = cur.parentElement;
    }
    container = climbed;
    via = "layout";
  }

  if (!container || !headingEl) return null;

  const nodeId = `n${++nodeCounter}`;
  elementMap.set(nodeId, container);
  registerSlotEl(nodeId, "headline", headingEl);

  // 4. Slots
  const slots: PageNode["slots"] = {};
  slots.headline = { kind: "text", text: headingEl.textContent?.trim() ?? "" };

  // subhead: next visible text ≤ 300 chars inside hero
  const allText = container.querySelectorAll("p, h2, h3, span, div");
  for (const t of allText) {
    if (t === headingEl || !isVisible(t) || t.contains(headingEl)) continue;
    const txt = t.textContent?.trim() ?? "";
    if (txt.length > 0 && txt.length <= 300) {
      slots.subhead = { kind: "text", text: txt };
      registerSlotEl(nodeId, "subhead", t);
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
      registerSlotEl(nodeId, "cta", el);
      break;
    }
  }

  return {
    id: nodeId,
    path: "hero",
    type: "hero",
    selector: buildSelector(container),
    rect: rectOf(container),
    slots,
    facts: textMetrics(headingEl),
    classes: Array.from(container.classList),
    via,
  };
}

// ── framework fingerprints (ladder rung 2, TECH-SPEC §6) ───────────────────────

function detectFramework(): { tailwind: boolean; mui: boolean } {
  return {
    mui: !!document.querySelector('[class*="Mui"]'),
    tailwind: !!document.querySelector(
      '[class*="grid-cols-"], [class*="max-w-"], [class*="divide-y"], [class*="flex-col"]'
    ),
  };
}

const TAILWIND_MARKERS = ["divide-y", "grid-cols-", "max-w-", "container"];
function looksLikeTailwindMarked(cl: string): boolean {
  if (TAILWIND_MARKERS.some((m) => cl.includes(m))) return true;
  return /\bpy-\d{2}\b/.test(cl);
}

function looksLikeFrameworkMarked(el: Element, fw: { tailwind: boolean; mui: boolean }): boolean {
  const cl = Array.from(el.classList).join(" ");
  if (fw.mui && /\bMui[A-Za-z]+-root\b/.test(cl)) return true;
  if (fw.tailwind && looksLikeTailwindMarked(cl)) return true;
  return false;
}

// ── container discovery (ladder rungs 3–4) ─────────────────────────────────────

/** Rung 3 (semantic) with a rung-4 (layout) fallback when the page has no sectioning elements
 *  at all. Deliberately shallow for rung 4 — a last resort, not a replacement for real markup. */
function discoverCandidates(root: Element): HTMLElement[] {
  const semantic = Array.from(
    root.querySelectorAll<HTMLElement>("section, article, [class*='MuiCard-root']")
  );
  if (semantic.length > 0) {
    return semantic.filter(
      (el) => isVisible(el) && !semantic.some((other) => other !== el && other.contains(el))
    );
  }
  const vw = window.innerWidth;
  return Array.from(root.children).filter((c): c is HTMLElement => {
    if (!(c instanceof HTMLElement) || !isVisible(c)) return false;
    const r = c.getBoundingClientRect();
    return r.width >= vw * 0.5 && r.height >= 150;
  });
}

/** Repeated-sibling-shape heuristic: >=3 direct children sharing a tag+classlist signature,
 *  covering a clear majority of the container's children → this is a collection, not prose. */
function findRepeatedChildren(el: Element): HTMLElement[] | null {
  const children = Array.from(el.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && isVisible(c)
  );
  if (children.length < 3) return null;
  const groups = new Map<string, HTMLElement[]>();
  for (const c of children) {
    const sig = `${c.tagName}|${Array.from(c.classList).sort().join(" ")}`;
    const arr = groups.get(sig) ?? [];
    arr.push(c);
    groups.set(sig, arr);
  }
  let best: HTMLElement[] = [];
  for (const arr of groups.values()) if (arr.length > best.length) best = arr;
  if (best.length >= 3 && best.length / children.length >= 0.6) return best;
  return null;
}

// ── section node (heading + optional body prose, no repeated children found) ──
function buildSectionNode(el: Element, path: string, via: NonNullable<PageNode["via"]>): PageNode {
  const nodeId = `n${++nodeCounter}`;
  elementMap.set(nodeId, el);

  const heading = findHeadingIn(el);
  const slots: PageNode["slots"] = {};
  let facts: PageNode["facts"] | undefined;
  if (heading) {
    slots.heading = { kind: "text", text: heading.textContent?.trim() ?? "" };
    registerSlotEl(nodeId, "heading", heading);
    facts = textMetrics(heading);
  }

  const bodyEl = Array.from(el.querySelectorAll<HTMLElement>("p")).find((p) => {
    if (!isVisible(p) || p === heading || (heading && heading.contains(p))) return false;
    const len = p.textContent?.trim().length ?? 0;
    return len > 0 && len <= 300;
  });
  if (bodyEl) {
    slots.body = { kind: "text", text: bodyEl.textContent?.trim() ?? "" };
    registerSlotEl(nodeId, "body", bodyEl);
  }

  // A section can carry its own CTA/media (e.g. a promo band) — not just prose. Registering
  // these as slots (rather than silently ignoring them) is what lets the ADA audit catch an
  // unfocusable in-section CTA or a missing alt that isn't inside a card.
  const ctaEl = Array.from(el.querySelectorAll<HTMLElement>("a, button")).find(
    (a) => isVisible(a) && (a.textContent?.trim().length ?? 0) > 0
  );
  if (ctaEl) {
    slots.cta = {
      kind: "link",
      text: ctaEl.textContent?.trim(),
      href: (ctaEl as HTMLAnchorElement).href || undefined,
    };
    registerSlotEl(nodeId, "cta", ctaEl);
  }

  const mediaEl = el.querySelector<HTMLImageElement>("img");
  if (mediaEl && isVisible(mediaEl)) {
    slots.media = {
      kind: "media",
      src: mediaEl.src || undefined,
      alt: mediaEl.getAttribute("alt") ?? undefined,
    };
    registerSlotEl(nodeId, "media", mediaEl);
    facts = { ...facts, missingAlt: mediaMissingAlt(mediaEl) };
  }

  return {
    id: nodeId,
    path,
    type: "section",
    selector: buildSelector(el),
    rect: rectOf(el),
    slots,
    facts,
    classes: Array.from(el.classList),
    via,
  };
}

// ── collection + card nodes ─────────────────────────────────────────────────────
function buildCollectionNode(
  sectionEl: Element,
  cardContainerEl: Element,
  cardEls: HTMLElement[],
  path: string,
  via: NonNullable<PageNode["via"]>
): { collection: PageNode; cards: PageNode[] } {
  const nodeId = `n${++nodeCounter}`;
  elementMap.set(nodeId, sectionEl);

  const heading = findHeadingIn(sectionEl, cardContainerEl === sectionEl ? undefined : cardContainerEl);
  const slots: PageNode["slots"] = {};
  let facts: PageNode["facts"] | undefined;
  if (heading && !cardContainerEl.contains(heading)) {
    slots.heading = { kind: "text", text: heading.textContent?.trim() ?? "" };
    registerSlotEl(nodeId, "heading", heading);
    facts = textMetrics(heading);
  }

  const cardIds: string[] = [];
  const cardNodes: PageNode[] = [];

  cardEls.forEach((cardEl, i) => {
    const cardId = `n${++nodeCounter}`;
    elementMap.set(cardId, cardEl);
    cardIds.push(cardId);

    const cardSlots: PageNode["slots"] = {};
    let cardFacts: PageNode["facts"] | undefined;

    const titleEl = cardEl.querySelector<HTMLElement>("h1, h2, h3, h4, [role=heading]");
    if (titleEl && isVisible(titleEl)) {
      cardSlots.title = { kind: "text", text: titleEl.textContent?.trim() ?? "" };
      registerSlotEl(cardId, "title", titleEl);
      cardFacts = textMetrics(titleEl);
    }

    const descEl = Array.from(cardEl.querySelectorAll<HTMLElement>("p")).find((p) => {
      if (!isVisible(p) || p === titleEl) return false;
      return (p.textContent?.trim().length ?? 0) > 0;
    });
    if (descEl) {
      cardSlots.description = { kind: "text", text: descEl.textContent?.trim() ?? "" };
      registerSlotEl(cardId, "description", descEl);
    }

    const mediaEl = cardEl.querySelector<HTMLImageElement>("img");
    if (mediaEl) {
      cardSlots.media = {
        kind: "media",
        src: mediaEl.src || undefined,
        alt: mediaEl.getAttribute("alt") ?? undefined,
      };
      registerSlotEl(cardId, "media", mediaEl);
      cardFacts = { ...cardFacts, missingAlt: mediaMissingAlt(mediaEl) };
    }

    const linkEl: HTMLAnchorElement | null =
      cardEl.tagName === "A" ? (cardEl as HTMLAnchorElement) : cardEl.querySelector("a");
    if (linkEl) {
      cardSlots.link = {
        kind: "link",
        href: linkEl.href || undefined,
        text: linkEl.textContent?.trim() || undefined,
      };
      registerSlotEl(cardId, "link", linkEl);
      cardFacts = { ...cardFacts, focusable: isFocusable(linkEl) };
    }

    cardNodes.push({
      id: cardId,
      path: `${path}.card${i + 1}`,
      type: "card",
      selector: buildSelector(cardEl),
      rect: rectOf(cardEl),
      slots: cardSlots,
      facts: cardFacts,
      classes: Array.from(cardEl.classList),
      via,
    });
  });

  const collection: PageNode = {
    id: nodeId,
    path,
    type: "collection",
    selector: buildSelector(sectionEl),
    rect: rectOf(sectionEl),
    slots,
    facts,
    classes: Array.from(sectionEl.classList),
    children: cardIds,
    via,
  };

  return { collection, cards: cardNodes };
}

// ── orphan leaves (leaf-node rule): visible top-level content no container claimed ──
function collectOrphanLeaves(root: Element, claimed: Set<Element>): PageNode[] {
  const results: PageNode[] = [];
  const isClaimedOrInside = (el: Element) =>
    claimed.has(el) || Array.from(claimed).some((c) => c.contains(el) || el.contains(c));

  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement) || !isVisible(child)) continue;
    if (isClaimedOrInside(child)) continue;

    const nodeId = `n${++nodeCounter}`;
    elementMap.set(nodeId, child);
    const leafIdx = results.length + 1;

    if (child.tagName === "IMG") {
      const img = child as HTMLImageElement;
      registerSlotEl(nodeId, "media", img);
      results.push({
        id: nodeId,
        path: `leaf${leafIdx}`,
        type: "media",
        selector: buildSelector(child),
        rect: rectOf(child),
        slots: {
          media: { kind: "media", src: img.src || undefined, alt: img.getAttribute("alt") ?? undefined },
        },
        facts: { missingAlt: mediaMissingAlt(img) },
        classes: Array.from(child.classList),
        via: "layout",
      });
      continue;
    }

    const text = child.textContent?.trim() ?? "";
    if (text.length === 0) continue; // pure layout chrome — nothing to surface

    if (child.tagName === "A") {
      registerSlotEl(nodeId, "link", child);
      results.push({
        id: nodeId,
        path: `leaf${leafIdx}`,
        type: "link",
        selector: buildSelector(child),
        rect: rectOf(child),
        slots: { link: { kind: "link", text, href: (child as HTMLAnchorElement).href || undefined } },
        facts: { focusable: isFocusable(child) },
        classes: Array.from(child.classList),
        via: "layout",
      });
      continue;
    }

    registerSlotEl(nodeId, "text", child);
    results.push({
      id: nodeId,
      path: `leaf${leafIdx}`,
      type: "text",
      selector: buildSelector(child),
      rect: rectOf(child),
      slots: { text: { kind: "text", text } },
      facts: textMetrics(child),
      classes: Array.from(child.classList),
      via: "layout",
    });
  }
  return results;
}

// ── ADA audit rollup (deterministic; every finding traces to a computed fact) ──
interface AuditTarget {
  path: string;
  kind: "text" | "media" | "link";
  el: Element;
}

function collectAuditTargets(node: PageNode, targets: AuditTarget[]): void {
  for (const [slotName, slot] of Object.entries(node.slots)) {
    const el = elementMap.get(`${node.id}.${slotName}`);
    if (!el) continue;
    targets.push({ path: `${node.path}.${slotName}`, kind: slot.kind, el });
  }
}

function computeAdaFindings(targets: AuditTarget[]): Finding[] {
  const findings: Finding[] = [];
  const headingLevels: { path: string; level: number }[] = [];

  for (const t of targets) {
    if (t.kind === "text") {
      const fontPx = parseFloat(window.getComputedStyle(t.el).fontSize) || 0;
      const contrast = computeContrast(t.el);
      if (contrast !== undefined) {
        const threshold = fontPx >= 24 ? 3 : 4.5;
        if (contrast < threshold) {
          findings.push({
            path: t.path,
            issue: `low contrast (${contrast.toFixed(2)}:1, needs ${threshold}:1)`,
          });
        }
      }
      if (/^H[1-6]$/.test(t.el.tagName)) {
        headingLevels.push({ path: t.path, level: parseInt(t.el.tagName.slice(1), 10) });
      }
    } else if (t.kind === "media") {
      if (mediaMissingAlt(t.el)) {
        findings.push({ path: t.path, issue: "missing alt text" });
      }
    } else if (t.kind === "link") {
      if (!isFocusable(t.el)) {
        findings.push({ path: t.path, issue: "CTA not keyboard-focusable" });
      }
    }
  }

  // Broken heading hierarchy: a level must never jump by more than 1 versus the PREVIOUS
  // heading among our detected nodes (WCAG technique G141), in document order.
  let prevLevel: number | null = null;
  for (const h of headingLevels) {
    if (prevLevel !== null && h.level - prevLevel > 1) {
      findings.push({ path: h.path, issue: `heading level jumps from h${prevLevel} to h${h.level}` });
    }
    prevLevel = h.level;
  }

  return findings;
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

// ── whole-page walk (PRD §4.2 detection ladder) ────────────────────────────────
// Deterministic per call: same DOM in → same schema out. `extract` resets all per-extraction
// state (node ids, element map) so repeated calls against an unchanged page produce identical
// results — see e2e/m2-deep-extraction.spec.ts "deterministic" spec.
function extractPage(
  hostname: string
): { nodes: PageNode[]; seo: ReturnType<typeof extractSEO>; a11yAudit: Finding[] } {
  nodeCounter = 0;
  elementMap.clear();

  const nodes: PageNode[] = [];
  const auditTargets: AuditTarget[] = [];

  const hero = detectHero(hostname);
  const claimed = new Set<Element>();
  if (hero) {
    nodes.push(hero);
    collectAuditTargets(hero, auditTargets);
    const heroEl = elementMap.get(hero.id);
    if (heroEl) claimed.add(heroEl);
  }

  // Prefer the <main> with the most text content — some pages ship more than one <main> (e.g. a
  // near-empty schema.org wrapper ahead of the real content main); picking the first blindly
  // would root the whole walk on an almost-empty element and find nothing.
  const mains = Array.from(document.querySelectorAll("main"));
  const root: Element =
    mains.length > 0
      ? mains.reduce((a, b) => ((b.textContent?.length ?? 0) > (a.textContent?.length ?? 0) ? b : a))
      : document.body;

  const fw = detectFramework();
  const profile = PROFILES[hostname];

  let sectionIdx = 0;
  let collectionIdx = 0;

  // ── rung 1: per-hostname profile overrides ──
  if (profile?.collections) {
    const allSections = Array.from(root.querySelectorAll<HTMLElement>("section, article"));
    for (const override of profile.collections) {
      const containerEl = document.querySelector(override.container);
      if (!containerEl || claimed.has(containerEl)) continue;

      const cardEls = (
        override.cardSelector
          ? Array.from(containerEl.querySelectorAll<HTMLElement>(override.cardSelector))
          : (Array.from(containerEl.children).filter((c) => c instanceof HTMLElement) as HTMLElement[])
      ).filter(isVisible);
      if (cardEls.length === 0) continue;

      const enclosing: HTMLElement =
        allSections.find((s) => s.contains(containerEl) && !claimed.has(s)) ??
        (containerEl as HTMLElement);

      collectionIdx++;
      const { collection, cards } = buildCollectionNode(
        enclosing,
        containerEl,
        cardEls,
        `collection${collectionIdx}`,
        "profile"
      );
      nodes.push(collection, ...cards);
      collectAuditTargets(collection, auditTargets);
      for (const c of cards) collectAuditTargets(c, auditTargets);
      claimed.add(enclosing);
      claimed.add(containerEl);
    }
  }

  // ── rungs 2–4: framework fingerprint / semantic HTML / layout ──
  const isClaimedOrOverlapping = (el: Element) =>
    claimed.has(el) || Array.from(claimed).some((c) => c.contains(el) || el.contains(c));

  const candidates = discoverCandidates(root).filter((el) => !isClaimedOrOverlapping(el));

  for (const el of candidates) {
    if (isClaimedOrOverlapping(el)) continue; // an earlier candidate in this loop may have claimed it

    const repeated = findRepeatedChildren(el);
    const usedFrameworkSignal =
      looksLikeFrameworkMarked(el, fw) || (repeated ? looksLikeFrameworkMarked(repeated[0], fw) : false);
    const isSemanticTag = el.tagName === "SECTION" || el.tagName === "ARTICLE";
    const via: NonNullable<PageNode["via"]> = usedFrameworkSignal
      ? "framework"
      : isSemanticTag
        ? "semantic"
        : "layout";

    if (repeated) {
      collectionIdx++;
      const { collection, cards } = buildCollectionNode(el, el, repeated, `collection${collectionIdx}`, via);
      nodes.push(collection, ...cards);
      collectAuditTargets(collection, auditTargets);
      for (const c of cards) collectAuditTargets(c, auditTargets);
    } else {
      sectionIdx++;
      const node = buildSectionNode(el, `section${sectionIdx}`, via);
      nodes.push(node);
      collectAuditTargets(node, auditTargets);
    }
    claimed.add(el);
  }

  // ── orphan leaves (leaf-node rule) ──
  const orphans = collectOrphanLeaves(root, claimed);
  nodes.push(...orphans);
  for (const o of orphans) collectAuditTargets(o, auditTargets);

  const seo = extractSEO();
  const a11yAudit = computeAdaFindings(auditTargets);

  return { nodes, seo, a11yAudit };
}

// ── overlay drawing ──
function clearOverlay(): void {
  if (overlayContainer) {
    overlayContainer.remove();
    overlayContainer = null;
  }
}

function factsSummary(facts: PageNode["facts"]): string {
  if (!facts) return "";
  const bits: string[] = [];
  if (facts.lines !== undefined) bits.push(`${facts.lines}L`);
  if (facts.fontPx !== undefined) bits.push(`${facts.fontPx}px`);
  if (facts.contrast !== undefined) bits.push(`${facts.contrast}:1`);
  if (facts.missingAlt) bits.push("no-alt");
  if (facts.truncated) bits.push("truncated");
  return bits.length > 0 ? ` · ${bits.join(" ")}` : "";
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
    // via-tag + facts summary are shown right in the label — the "we understand this page"
    // proof, debuggable at a glance (PRD §4.2).
    label.textContent =
      `${node.path} · ${node.type}` + (node.via ? ` · ${node.via}` : "") + factsSummary(node.facts);

    box.appendChild(label);
    overlayContainer.appendChild(box);
  }
}

// ── M3 warn-only regression checks (TECH-SPEC §6) ──────────────────────────────
// After every apply, re-compute the touched slots' facts and flag regressions on the op:
// overflow growth, line-count growth, contrast falling below WCAG AA, lost alt text. Warn-only
// — NEVER blocks or retries (the full verify loop is M7); this is the honesty layer.

interface RegressionSnapshot {
  lines?: number;
  fontPx?: number;
  contrast?: number;
  overflowing?: boolean;
  missingAlt?: boolean;
}

/** scrollWidth/scrollHeight vs clientWidth/clientHeight — a plain, direct overflow check
 *  (distinct from textMetrics' `truncated`, which also true's on static ellipsis CSS present
 *  regardless of content — that would never show a false->true transition on a REGRESSION). */
function isOverflowing(el: Element): boolean {
  const he = el as HTMLElement;
  return he.scrollWidth > he.clientWidth || he.scrollHeight > he.clientHeight;
}

/** Snapshot a touched slot's regression-relevant facts: for media, just missingAlt; for text,
 *  lines/fontPx/contrast plus overflow of the slot element OR its direct parent ("the target or
 *  its parent", TECH-SPEC §6) — the parent is where a fixed-size wrapper would clip growth the
 *  slot element itself (often auto-sized) would never show. */
function regressionSnapshot(slotEl: Element): RegressionSnapshot {
  if (slotEl.tagName === "IMG") return { missingAlt: mediaMissingAlt(slotEl) };
  const metrics = textMetrics(slotEl);
  const parent = slotEl.parentElement;
  const overflowing = isOverflowing(slotEl) || (parent ? isOverflowing(parent) : false);
  return { lines: metrics.lines, fontPx: metrics.fontPx, contrast: metrics.contrast, overflowing };
}

/** Diff before/after snapshots for one slot into human-readable warning strings. Pure —
 *  exercised directly by e2e/m3-variants.spec.ts against synthetic before/after facts, no DOM
 *  needed, alongside the live-fixture apply-op specs. */
function regressionWarnings(slotName: string, before: RegressionSnapshot, after: RegressionSnapshot): string[] {
  const warnings: string[] = [];

  if ("missingAlt" in before || "missingAlt" in after) {
    if (!before.missingAlt && after.missingAlt) warnings.push(`${slotName}: alt text lost`);
    return warnings;
  }

  if (!before.overflowing && after.overflowing) {
    warnings.push(`${slotName}: overflow — content now exceeds its container`);
  }
  if (before.lines !== undefined && after.lines !== undefined && after.lines > before.lines) {
    warnings.push(`${slotName}: line count grew from ${before.lines} to ${after.lines}`);
  }
  if (before.contrast !== undefined && after.contrast !== undefined) {
    const fontPx = after.fontPx ?? 16;
    const threshold = fontPx >= 24 ? 3 : 4.5;
    if (before.contrast >= threshold && after.contrast < threshold) {
      warnings.push(
        `${slotName}: contrast dropped below WCAG AA (${before.contrast.toFixed(2)}:1 → ${after.contrast.toFixed(2)}:1)`
      );
    }
  }
  return warnings;
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
      // Hostname resolution order:
      //  1. msg.hostnameOverride — debug-only hook so deterministic e2e specs can compare "with
      //     profile" vs "generic-only" against the SAME live DOM without re-navigating.
      //  2. window.__overlayTargetHost — the ORIGINAL target hostname, injected by
      //     /api/ingest (the page is served same-origin from OUR host via <base href>, so
      //     location.hostname here is never the target's — see route.ts for why).
      //  3. location.hostname — fallback for the runtime-fixture test harness, where a bare
      //     page has neither of the above.
      const hostname =
        (typeof msg.hostnameOverride === "string" && msg.hostnameOverride) ||
        (window as unknown as { __overlayTargetHost?: string }).__overlayTargetHost ||
        location.hostname;
      const { nodes, seo, a11yAudit } = extractPage(hostname);
      lastNodes = nodes;
      if (overlayOn) drawOverlay(nodes);
      post({ t: "schema", nodes, seo, a11yAudit, requestId: msg.requestId });
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

      // M3 warn-only regression checks: snapshot BEFORE facts per touched slot, ahead of the
      // mutation, so we can diff against AFTER once things settle.
      const before: Record<string, RegressionSnapshot> = {};
      for (const slotName of Object.keys(op.slots)) {
        const slotEl = getSlotElement(op.target, slotName, el);
        if (slotEl) before[slotName] = regressionSnapshot(slotEl);
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

      // Defer the AFTER measurement one animation frame: microtasks (including any
      // MutationObserver callbacks the HOST page itself installed, and general layout/style
      // settling from the text change) always drain before "update the rendering" runs — so by
      // the time this fires, AFTER never races a still-pending style recalc. Warn-only: never
      // blocks ok:true, never retries (TECH-SPEC §6).
      requestAnimationFrame(() => {
        const warnings: string[] = [];
        for (const slotName of Object.keys(op.slots)) {
          const slotEl = getSlotElement(op.target, slotName, el);
          const beforeFacts = before[slotName];
          if (!slotEl || !beforeFacts) continue;
          const afterFacts = regressionSnapshot(slotEl);
          warnings.push(...regressionWarnings(slotName, beforeFacts, afterFacts));
        }

        post({ t: "op-applied", opId, ok: true, warnings: warnings.length > 0 ? warnings : undefined, requestId });
        if (overlayOn) drawOverlay(lastNodes);
      });
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
