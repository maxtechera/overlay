/**
 * e2e/m2-deep-extraction.spec.ts
 * M2a acceptance checklist specs (issue #2) — all @m2, all keyless/deterministic (no LLM
 * anywhere in extraction — PRD §4.2).
 *
 * Acceptance items (issue #2):
 * 1. On maxtechera.dev: hero + ≥3 sections identified; cards where they exist      @m2
 * 2. Facts spot-check TRUE against devtools (lines · fontPx · contrast) on 3 nodes @m2
 * 3. ADA findings all trace to computed facts; contrast skipped over bg images    @m2
 * 4. Leaf-node rule holds: no per-paragraph nodes inside detected containers      @m2
 * 5. Deterministic: two extractions → identical schemas (deep-equal)             @m2
 * 6. One profile override demonstrably fixes a generic-pass miss                 @m2
 *
 * Fixture specs (3, part of 2) use a hand-built, deterministic DOM via
 * e2e/helpers/runtime-fixture.ts — a live site can't reliably reproduce "text over a CSS
 * background-image" or a specific heading-hierarchy skip on demand (CLAUDE.md Learnings,
 * 2026-07-08: external sites drift; use fixtures for edge cases). Items 1/2/4/5/6 run against
 * the real maxtechera.dev target, per CLAUDE.md's MVP-slice scoping.
 */

import { test, expect, type Page } from "@playwright/test";
import { loadFixture, extractOnFixture } from "./helpers/runtime-fixture";

type PageNodeLike = {
  id: string;
  path: string;
  type: string;
  via?: string;
  selector: { css: string; fingerprint?: string };
  slots: Record<string, { kind: string; text?: string; href?: string; src?: string; alt?: string }>;
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
};

// ── independent (duplicate, NOT imported from lib/runtime.ts) WCAG contrast implementation —
// used ONLY to cross-check the runtime's own numbers against a from-scratch recomputation,
// the automated equivalent of reading the same values off devtools. ──
function relLuminance(r: number, g: number, b: number): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}
function parseRgb(str: string): { r: number; g: number; b: number; a: number } | null {
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(",").map((s) => parseFloat(s.trim()));
  return { r: p[0] ?? 0, g: p[1] ?? 0, b: p[2] ?? 0, a: p.length > 3 ? p[3] : 1 };
}

async function submitAndWaitSchema(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({
    timeout: 30_000,
  });
  // The full schema (incl. a11yAudit) lands slightly after schema-msg's own re-render — poll
  // the test hook app/page.tsx sets alongside it (window.__overlaySchema).
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __overlaySchema?: unknown[] }).__overlaySchema?.length ?? 0), {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
}

async function getSchema(page: Page): Promise<PageNodeLike[]> {
  return page.evaluate(
    () => (window as unknown as { __overlaySchema?: PageNodeLike[] }).__overlaySchema ?? []
  );
}

async function getA11y(page: Page): Promise<{ path: string; issue: string }[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __overlayA11y?: { path: string; issue: string }[] }).__overlayA11y ??
      []
  );
}

// ── 1. Hero + ≥3 sections identified; cards where they exist ──────────────────────

test("1 · maxtechera.dev: hero + ≥3 sections identified, cards where they exist @m2", async ({
  page,
}) => {
  await submitAndWaitSchema(page);
  const nodes = await getSchema(page);

  const hero = nodes.find((n) => n.type === "hero");
  expect(hero, "hero node").toBeTruthy();
  expect(hero!.slots.headline?.text?.length ?? 0).toBeGreaterThan(0);

  const sectionsAndCollections = nodes.filter((n) => n.type === "section" || n.type === "collection");
  expect(
    sectionsAndCollections.length,
    `expected ≥3 section/collection containers, got: ${sectionsAndCollections.map((n) => `${n.path}(${n.type})`).join(", ")}`
  ).toBeGreaterThanOrEqual(3);

  const cards = nodes.filter((n) => n.type === "card");
  expect(cards.length, "cards where they exist on maxtechera.dev (course/blog/logo collections)").toBeGreaterThan(0);

  // Every collection's `children` ids resolve to real card nodes in the same schema.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const col of nodes.filter((n) => n.type === "collection")) {
    expect(col.children?.length ?? 0).toBeGreaterThan(0);
    for (const childId of col.children ?? []) {
      expect(byId.has(childId), `${col.path} child ${childId} must resolve to a node`).toBe(true);
      expect(byId.get(childId)!.type).toBe("card");
    }
  }
});

// ── 2. Facts spot-check against an independent recomputation on 3 real nodes ───────

test("2 · facts (lines · fontPx · contrast) spot-check TRUE against an independent recomputation on 3 nodes @m2", async ({
  page,
}) => {
  await submitAndWaitSchema(page);
  const nodes = await getSchema(page);

  const hero = nodes.find((n) => n.type === "hero")!;
  const section = nodes.find((n) => n.type === "section" && n.facts?.fontPx !== undefined);
  const card = nodes.find((n) => n.type === "card" && n.facts?.fontPx !== undefined);
  expect(section, "a section with a heading (facts present)").toBeTruthy();
  expect(card, "a card with a title (facts present)").toBeTruthy();

  const spotCheck = async (node: PageNodeLike, slotName: string) => {
    const iframe = page.getByTestId("preview-iframe");
    const result = await iframe.evaluate(
      (el: HTMLIFrameElement, args: { css: string; slotName: string }) => {
        const doc = el.contentDocument!;
        const container = doc.querySelector(args.css);
        if (!container) return null;
        const target =
          args.slotName === "headline" || args.slotName === "heading" || args.slotName === "title"
            ? container.querySelector("h1, h2, h3, h4, [role=heading]") ?? container
            : container;
        const cs = window.getComputedStyle(target);
        const fontPx = parseFloat(cs.fontSize) || undefined;
        const lineHeightRaw = parseFloat(cs.lineHeight);
        const lineHeight =
          Number.isFinite(lineHeightRaw) && lineHeightRaw > 0 ? lineHeightRaw : (fontPx ?? 16) * 1.2;
        const rect = target.getBoundingClientRect();
        const lines = fontPx ? Math.max(1, Math.round(rect.height / lineHeight)) : undefined;
        const color = cs.color;
        // Walk for effective background (duplicated here deliberately — independent check)
        let bg: string | null = null;
        let cur: Element | null = target;
        let sawBgImage = false;
        while (cur) {
          const c = window.getComputedStyle(cur);
          if (c.backgroundImage && c.backgroundImage !== "none") {
            sawBgImage = true;
            break;
          }
          const m = c.backgroundColor.match(/rgba?\(([^)]+)\)/);
          if (m) {
            const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
            const a = parts.length > 3 ? parts[3] : 1;
            if (a > 0.999) {
              bg = c.backgroundColor;
              break;
            }
            if (a > 0) {
              sawBgImage = true; // partial alpha — treated the same as "unknown" by both sides
              break;
            }
          }
          cur = cur.parentElement;
        }
        return { fontPx, lines, color, bg, sawBgImage };
      },
      { css: node.selector.css, slotName }
    );
    expect(result, `${node.path} element resolvable via its own selector`).toBeTruthy();
    const { fontPx, lines, color, bg, sawBgImage } = result!;

    expect(fontPx, `${node.path}.${slotName} fontPx`).toBe(node.facts?.fontPx);
    expect(lines, `${node.path}.${slotName} lines`).toBe(node.facts?.lines);

    if (sawBgImage) {
      expect(node.facts?.contrast, `${node.path}.${slotName} contrast must be undefined over a bg-image`).toBeUndefined();
    } else {
      const fg = parseRgb(color)!;
      const bgc = bg ? parseRgb(bg)! : { r: 255, g: 255, b: 255, a: 1 };
      const la = relLuminance(fg.r, fg.g, fg.b) + 0.05;
      const lb = relLuminance(bgc.r, bgc.g, bgc.b) + 0.05;
      const expectedContrast = Math.round((la > lb ? la / lb : lb / la) * 100) / 100;
      expect(node.facts?.contrast, `${node.path}.${slotName} contrast`).toBe(expectedContrast);
    }
  };

  await spotCheck(hero, "headline");
  await spotCheck(section!, "heading");
  await spotCheck(card!, "title");
});

// ── 3. ADA audit: findings trace to facts; contrast skipped over bg-images (fixture) ──

test("3 · ADA findings trace to computed facts; contrast is skipped (not faked) over a background image @m2", async ({
  page,
}) => {
  const html = `<!DOCTYPE html><html><head><title>ADA fixture</title></head>
<body style="margin:0">
<main>
  <section style="min-height:260px;padding:24px;">
    <h1 style="font-size:48px;margin:0;">Fixture Hero Heading</h1>
    <p style="font-size:18px;">A short, high-contrast subhead.</p>
    <a href="/get-started" style="font-size:16px;">Get started</a>
  </section>
  <section style="padding:24px;">
    <h3 style="margin:0;">Skipped level heading</h3>
    <p style="font-size:14px;color:#cccccc;">Low contrast paragraph text on a white page.</p>
    <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7" width="10" height="10">
    <a href="/no-focus" tabindex="-1">Not focusable CTA</a>
  </section>
  <section style="padding:24px;background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7);">
    <h2 style="margin:0;color:#000;">Text over a background image</h2>
  </section>
</main>
</body></html>`;

  await loadFixture(page, html);
  const { nodes, a11yAudit } = await extractOnFixture(page, { hostnameOverride: "fixture.invalid" });

  const typed = nodes as unknown as PageNodeLike[];
  const hero = typed.find((n) => n.type === "hero");
  expect(hero, "hero detected on the fixture").toBeTruthy();

  const bgImageSection = typed.find(
    (n) => n.type === "section" && n.slots.heading?.text === "Text over a background image"
  );
  expect(bgImageSection, "the bg-image section itself").toBeTruthy();
  expect(
    bgImageSection!.facts?.contrast,
    "contrast MUST be undefined (skipped), never a faked number, over a background image"
  ).toBeUndefined();

  // Every finding traces to a real path in the schema.
  const allPaths = new Set<string>();
  for (const n of typed) {
    for (const slotName of Object.keys(n.slots)) allPaths.add(`${n.path}.${slotName}`);
  }
  expect(a11yAudit.length).toBeGreaterThan(0);
  for (const f of a11yAudit) {
    expect(allPaths.has(f.path), `finding path "${f.path}" traces to a real node.slot`).toBe(true);
  }

  // The 4 specific, deliberately-planted violations are all present…
  expect(a11yAudit.some((f) => /low contrast/.test(f.issue))).toBe(true);
  expect(a11yAudit.some((f) => /missing alt/.test(f.issue))).toBe(true);
  expect(a11yAudit.some((f) => /not keyboard-focusable/.test(f.issue))).toBe(true);
  expect(a11yAudit.some((f) => /heading level jumps from h1 to h3/.test(f.issue))).toBe(true);

  // …and the bg-image section's OWN heading contributes zero findings (no faked low-contrast).
  expect(a11yAudit.some((f) => f.path.startsWith(`${bgImageSection!.path}.`))).toBe(false);
});

// ── 4. Leaf-node rule: no per-paragraph nodes inside detected containers ───────────

test("4 · leaf-node rule holds on maxtechera.dev: no per-paragraph nodes inside detected containers @m2", async ({
  page,
}) => {
  await submitAndWaitSchema(page);
  const nodes = await getSchema(page);

  // The page ships far more than a handful of <p> tags inside its sections/cards — if the
  // leaf-node rule were violated we'd see a "text" PageNode per paragraph (dozens). Orphan
  // "text" leaves should be rare (ideally zero on this page, since virtually everything is
  // wrapped in <section>).
  const textLeaves = nodes.filter((n) => n.type === "text");
  const pCountInIframe = await page.getByTestId("preview-iframe").evaluate((el: HTMLIFrameElement) => {
    const doc = el.contentDocument!;
    const main = Array.from(doc.querySelectorAll("main")).sort(
      (a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0)
    )[0];
    return (main ?? doc.body).querySelectorAll("p").length;
  });

  expect(pCountInIframe, "sanity: the real page has plenty of <p> tags to NOT turn into nodes").toBeGreaterThan(10);
  expect(
    textLeaves.length,
    `only orphan leaves may become "text" nodes — got ${textLeaves.length} for ${pCountInIframe} <p> tags`
  ).toBeLessThan(5);

  // Content INSIDE a section/collection/card is reachable only via slots, never as its own
  // top-level node: e.g. the hero's subhead text must not also appear as a "text" node.
  const hero = nodes.find((n) => n.type === "hero");
  const subheadText = hero?.slots.subhead?.text;
  if (subheadText) {
    expect(textLeaves.some((n) => n.slots.text?.text === subheadText)).toBe(false);
  }
});

// ── 5. Deterministic: two extractions → identical schemas ─────────────────────────

test("5 · deterministic: two extractions of the same page → identical schemas (deep-equal) @m2", async ({
  page,
}) => {
  await submitAndWaitSchema(page);

  // Compare only the extracted content (nodes/seo/a11yAudit) — `requestId` is a per-message
  // protocol field (TECH-SPEC §3: every postMessage carries one) and is EXPECTED to differ
  // between calls; it is not part of the extraction schema itself.
  const [first, second] = await page.evaluate(async () => {
    const host = (
      window as unknown as {
        __overlayHost: {
          sendToIframe: (
            m: Record<string, unknown>
          ) => Promise<{ nodes?: unknown; seo?: unknown; a11yAudit?: unknown }>;
        };
      }
    ).__overlayHost;
    const a = await host.sendToIframe({ t: "extract" });
    const b = await host.sendToIframe({ t: "extract" });
    const strip = (r: { nodes?: unknown; seo?: unknown; a11yAudit?: unknown }) => ({
      nodes: r.nodes,
      seo: r.seo,
      a11yAudit: r.a11yAudit,
    });
    return [strip(a), strip(b)];
  });

  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

// ── 6. Profile override demonstrably fixes a generic-pass miss ────────────────────

test("6 · profile override demonstrably fixes a generic-pass miss (maxtechera.dev logo collection) @m2", async ({
  page,
}) => {
  await submitAndWaitSchema(page);

  const [generic, withProfile] = await page.evaluate(async () => {
    const host = (
      window as unknown as {
        __overlayHost: {
          sendToIframe: (m: Record<string, unknown>) => Promise<{ nodes?: PageNodeLike[] }>;
        };
      }
    ).__overlayHost;
    type PageNodeLike = { slots: Record<string, { href?: string }> };
    const genericRes = await host.sendToIframe({
      t: "extract",
      hostnameOverride: "no-profile.invalid",
    });
    const profiledRes = await host.sendToIframe({
      t: "extract",
      hostnameOverride: "maxtechera.dev",
    });
    return [genericRes, profiledRes];
  });

  const hasOracleCard = (nodes: PageNodeLike[] | undefined) =>
    (nodes ?? []).some((n) =>
      Object.values(n.slots).some((s) => typeof s.href === "string" && s.href.includes("oracle.com"))
    );

  expect(
    hasOracleCard((generic as { nodes?: PageNodeLike[] }).nodes),
    "generic-only pass (no profile) misses the logo collection entirely"
  ).toBe(false);
  expect(
    hasOracleCard((withProfile as { nodes?: PageNodeLike[] }).nodes),
    "with the maxtechera.dev profile override, the logo collection's cards are detected"
  ).toBe(true);
});
