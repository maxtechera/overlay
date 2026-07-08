/**
 * e2e/helpers/runtime-fixture.ts — load the bundled iframe runtime (lib/runtime.built.js)
 * directly into a bare Playwright page, against a fully controlled fixture DOM.
 *
 * Why: several M2a acceptance items (contrast skipped over a background image, the layout-only
 * ladder fallback, a deliberately broken heading hierarchy) need a DOM whose exact markup we
 * control bit-for-bit — a live site drifts (CLAUDE.md Learnings, 2026-07-08) and can't be made
 * to reliably reproduce an edge case like "text over a CSS background-image" on demand.
 *
 * This runs the SAME production bundle (`pnpm test:e2e`'s `pretest:e2e` hook rebuilds it fresh)
 * against `page.setContent(...)`, with no iframe nesting: on a top-level page `window.parent
 * === window`, so runtime.ts's `window.parent.postMessage` / `window.addEventListener("message")`
 * both target the same window and work exactly as they do inside the real ingest iframe.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

let cachedCode: string | null = null;

/** Extract the raw runtime JS string from the esbuild-generated lib/runtime.built.js
 *  (`const runtimeCode = "...."`) via text parsing — deliberately NOT an import, to avoid any
 *  ESM/CJS resolution ambiguity between Playwright's test runner and this ES-module build
 *  artifact; this is plain, dependency-free text handling. */
function getRuntimeCode(): string {
  if (cachedCode) return cachedCode;
  const filePath = join(__dirname, "..", "..", "lib", "runtime.built.js");
  const raw = readFileSync(filePath, "utf-8");
  const match = raw.match(/const runtimeCode = (".*");\n/s);
  if (!match) {
    throw new Error("runtime-fixture: could not find `const runtimeCode = \"...\";` in runtime.built.js");
  }
  cachedCode = JSON.parse(match[1]) as string;
  return cachedCode;
}

/** Load `html` as the page's document, then inject the runtime bundle. Returns once the script
 *  has executed (module-level listeners are registered synchronously). */
export async function loadFixture(page: Page, html: string): Promise<void> {
  await page.goto("about:blank");
  await page.setContent(html);
  await page.addScriptTag({ content: getRuntimeCode() });
}

/** Send `{t: "extract", ...}` directly via window.postMessage and await the "schema" reply —
 *  bypasses the ready-handshake (irrelevant here; we call extract ourselves, on demand). */
export async function extractOnFixture(
  page: Page,
  opts?: { hostnameOverride?: string }
): Promise<{
  nodes: Array<Record<string, unknown>>;
  seo: Record<string, unknown>;
  a11yAudit: Array<{ path: string; issue: string }>;
}> {
  const result = await page.evaluate((hostnameOverride) => {
    return new Promise((resolve) => {
      const listener = (e: MessageEvent) => {
        const msg = e.data as {
          t?: string;
          requestId?: string;
          nodes?: unknown;
          seo?: unknown;
          a11yAudit?: unknown;
        };
        if (msg && msg.t === "schema" && msg.requestId === "fixture-req") {
          window.removeEventListener("message", listener);
          resolve({ nodes: msg.nodes, seo: msg.seo, a11yAudit: msg.a11yAudit });
        }
      };
      window.addEventListener("message", listener);
      window.postMessage({ t: "extract", requestId: "fixture-req", hostnameOverride }, "*");
    });
  }, opts?.hostnameOverride);
  return result as {
    nodes: Array<Record<string, unknown>>;
    seo: Record<string, unknown>;
    a11yAudit: Array<{ path: string; issue: string }>;
  };
}
