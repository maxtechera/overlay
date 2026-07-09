/**
 * lib/thumbnail.ts — TECH-SPEC §9 best-effort variant thumbnails.
 *
 * Runs in the PARENT, reaching into the SAME-ORIGIN iframe document (lib/runtime.ts stays
 * dependency-free — it never imports html2canvas). ANY failure (no document, a cross-origin
 * image tainting the canvas, the library throwing) resolves to `null`; callers render a styled
 * fallback card instead (components/VariantGallery.tsx) — this must never throw.
 */

import html2canvas from "html2canvas";

export async function captureThumbnail(
  iframeEl: HTMLIFrameElement | null | undefined
): Promise<string | null> {
  try {
    const body = iframeEl?.contentDocument?.body;
    if (!body) return null;
    const canvas = await html2canvas(body, {
      logging: false,
      useCORS: false,
      scale: 0.3,
      backgroundColor: "#ffffff",
    });
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
