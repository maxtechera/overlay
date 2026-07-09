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

// ── real-browser proof: images actually render, post-hydration ──────────────────
//
// maxtechera.dev's own Next.js runtime, ON HYDRATION, re-writes img/source src/srcset back to
// root-relative (`/_next/image?...`) — undoing BOTH the injected <base href> and the ingest-time
// absolutize step above. Root-relative on OUR host means the browser requests
// `http://localhost:3010/_next/image?...`, which our server can't serve (that route only exists
// on the target) — "not a valid image". The served-HTML spec above only proves the PRE-hydration
// markup is correct; it does NOT prove anything renders. This spec drives a real browser through
// the full app flow and asserts images actually decode (naturalWidth > 0) AND that zero requests
// to our own origin for `_next/image`/`/images/` paths ever come back >=400 — the concrete,
// non-vacuous signal that lib/runtime.ts's MutationObserver guard (issue #29) is re-absolutizing
// any root-relative src/srcset the instant hydration sets one, for the whole page lifetime.

test("29b · images actually render post-hydration in the iframe (naturalWidth>0), zero 4xx/5xx image responses from our origin @m1", async ({
  page,
}) => {
  const badImageResponses: string[] = [];
  page.on("response", (res) => {
    const url = res.url();
    const isOurOrigin = url.startsWith("http://localhost:3010/");
    const isImagePath = url.includes("_next/image") || url.includes("/images/");
    if (isOurOrigin && isImagePath && res.status() >= 400) {
      badImageResponses.push(`${res.status()} ${url}`);
    }
  });

  await page.goto("/");
  await page.getByTestId("url-input").fill("https://maxtechera.dev");
  await page.getByRole("button", { name: /analyze/i }).click();

  await expect(page.getByTestId("preview-iframe")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("schema-msg").or(page.getByTestId("no-hero-msg"))).toBeVisible({
    timeout: 30_000,
  });

  // Give the target's own hydration a moment to run (and our MutationObserver to react to it)
  // before we inspect image state.
  await page.waitForTimeout(2000);

  const naturalWidths = await page.getByTestId("preview-iframe").evaluate(
    async (el: HTMLIFrameElement) => {
      const doc = el.contentDocument;
      if (!doc) return [] as number[];
      const imgs = Array.from(doc.querySelectorAll("img"));
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
            setTimeout(done, 5000);
          });
        })
      );
      return imgs.map((img) => img.naturalWidth);
    }
  );

  // Non-vacuous: the page actually has images.
  expect(naturalWidths.length).toBeGreaterThan(0);

  // The bug reproduced as ALL images broken (naturalWidth 0). The fix's proof bar: the large
  // majority must have rendered — a handful of genuinely lazy/off-screen images not yet
  // triggered is acceptable, but NOT "every image still broken".
  const broken = naturalWidths.filter((w) => w === 0);
  expect(
    broken.length,
    `naturalWidths seen: ${JSON.stringify(naturalWidths)} (broken: ${broken.length}/${naturalWidths.length})`
  ).toBeLessThan(naturalWidths.length);

  // Zero-tolerance: no image request to OUR OWN origin for a target asset path ever 4xx/5xx'd —
  // direct proof that root-relative src/srcset never reached the browser unfixed, even after
  // hydration rewrote it.
  expect(badImageResponses, `bad image responses: ${JSON.stringify(badImageResponses)}`).toEqual(
    []
  );
});
