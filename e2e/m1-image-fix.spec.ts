/**
 * e2e/m1-image-fix.spec.ts
 * Issue #29 — ingested pages render with broken images: Next.js targets (maxtechera.dev)
 * emit root-relative optimizer URLs (`/_next/image?url=...`) in img/source src+srcset.
 * Served same-origin from OUR host, the target's own runtime re-resolves these against our
 * origin on hydration — `<base href>` alone doesn't survive that. Fix: absolutize
 * root-relative asset URLs (img/source src+srcset, link[href], inline style url()) to the
 * target origin in app/api/ingest/route.ts.
 *
 * Keyless, @m1 @smoke — no ANTHROPIC_API_KEY needed (pure HTTP fetch + HTML parse).
 */

import { test, expect } from "@playwright/test";
import { parse } from "node-html-parser";

test("29 · ingested maxtechera.dev has absolute-origin img/source src+srcset, no root-relative /_next/image or /images @m1 @smoke", async ({
  request,
}) => {
  const res = await request.get("/api/ingest?url=https://maxtechera.dev");
  expect(res.ok()).toBe(true);

  const html = await res.text();
  const root = parse(html);

  const targetOrigin = "https://maxtechera.dev";

  // Collect every src/srcset from img + source elements.
  const imgsAndSources = [...root.querySelectorAll("img"), ...root.querySelectorAll("source")];
  expect(imgsAndSources.length).toBeGreaterThan(0); // non-vacuous: the fixture page has images

  let checkedAttrCount = 0;

  for (const el of imgsAndSources) {
    const src = el.getAttribute("src");
    if (src) {
      checkedAttrCount++;
      // Must NOT be root-relative (bug: browser would resolve against OUR host, not the target)
      expect(src.startsWith("/")).toBe(false);
      // Root-relative optimizer/image paths must now be absolutized to the target origin
      if (src.includes("_next/image") || src.includes("/images/")) {
        expect(src.startsWith(targetOrigin)).toBe(true);
      }
    }

    const srcset = el.getAttribute("srcset");
    if (srcset) {
      const candidates = srcset.split(",").map((c) => c.trim());
      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        checkedAttrCount++;
        const url = candidate.split(" ")[0];
        expect(url.startsWith("/")).toBe(false); // never root-relative
        if (url.includes("_next/image") || url.includes("/images/")) {
          expect(url.startsWith(targetOrigin)).toBe(true);
        }
      }
    }
  }

  // Non-vacuous: we actually inspected some src/srcset values.
  expect(checkedAttrCount).toBeGreaterThan(0);

  // Belt + suspenders: <base href> is still injected.
  expect(html).toContain(`<base href="${targetOrigin}`);
});
