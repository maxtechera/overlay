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

/**
 * Send `{t: "apply-op", ...}` directly via window.postMessage and await the "op-applied" echo
 * for THIS opId (M3/#3's warn-only regression-check specs — e2e/m3-variants.spec.ts). Same
 * bypass-the-handshake pattern as extractOnFixture: we drive the runtime's message protocol
 * directly, no iframe/host needed.
 */
export async function applyOpOnFixture(
  page: Page,
  opId: string,
  op: { op: "update-content"; target: string; slots: Record<string, { text?: string; href?: string; src?: string; alt?: string }>; rationale: string }
): Promise<{ ok: boolean; error?: string; warnings?: string[] }> {
  const result = await page.evaluate(
    ({ opId, op }) => {
      return new Promise((resolve) => {
        const listener = (e: MessageEvent) => {
          const msg = e.data as { t?: string; opId?: string; ok?: boolean; error?: string; warnings?: string[] };
          if (msg && msg.t === "op-applied" && msg.opId === opId) {
            window.removeEventListener("message", listener);
            resolve({ ok: !!msg.ok, error: msg.error, warnings: msg.warnings });
          }
        };
        window.addEventListener("message", listener);
        window.postMessage({ t: "apply-op", opId, op, requestId: `fixture-apply-${opId}` }, "*");
      });
    },
    { opId, op }
  );
  return result as { ok: boolean; error?: string; warnings?: string[] };
}

/**
 * Send `{t: "revert-op", ...}` directly via window.postMessage and await the "op-reverted" echo
 * for THIS opId — the counterpart to applyOpOnFixture above, added additively for the M6 eval
 * harness's apply/revert round-trip smoke check (issue #6). Mirrors lib/runtime.ts's revert-op
 * handler exactly (same protocol shape e2e/m3-variants.spec.ts's tab-switch spec relies on).
 */
export async function revertOpOnFixture(page: Page, opId: string): Promise<{ opId: string }> {
  const result = await page.evaluate((opId) => {
    return new Promise((resolve) => {
      const listener = (e: MessageEvent) => {
        const msg = e.data as { t?: string; opId?: string };
        if (msg && msg.t === "op-reverted" && msg.opId === opId) {
          window.removeEventListener("message", listener);
          resolve({ opId: msg.opId });
        }
      };
      window.addEventListener("message", listener);
      window.postMessage({ t: "revert-op", opId, requestId: `fixture-revert-${opId}` }, "*");
    });
  }, opId);
  return result as { opId: string };
}
