/**
 * GET /api/ingest?url=<target>
 * Fetch + rewrite + inject — serves third-party pages same-origin so the iframe
 * can be scripted and the runtime can postMessage the parent.
 *
 * Steps (TECH-SPEC §2):
 * 1. Validate URL (http/https only; reject private IPs/localhost)
 * 2. Fetch with Chrome UA
 * 3. Reject: non-2xx, non-html, >5MB, bot-wall markers → 422
 * 4. Parse: remove CSP meta, strip experiment scripts, inject <base href>, inject runtime
 * 5. Respond text/html (no X-Frame-Options / CSP set)
 */

import { parse } from "node-html-parser";
import runtimeCode from "@/lib/runtime.built.js";
import { requireAuth } from "@/lib/auth";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const MAX_BODY = 5 * 1024 * 1024; // 5 MB

const BOT_WALL_MARKERS = ["cf-chl", "challenge-platform", "Just a moment"];

const EXPERIMENT_SCRIPT_PATTERN = /optimizely|vwo|convert\.com|abtasty|omniconvert/i;

/** Private IP / localhost check — SSRF guard */
function isPrivateOrLocalhost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  // 10.x.x.x / 172.16-31.x.x / 192.168.x.x / 169.254.x.x / 0.x.x.x
  if (
    /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
    /^192\.168\.\d+\.\d+$/.test(hostname) ||
    /^169\.254\.\d+\.\d+$/.test(hostname) ||
    /^0\.\d+\.\d+\.\d+$/.test(hostname)
  )
    return true;
  return false;
}

function err422(reason: string) {
  return new Response(JSON.stringify({ reason }), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
}

export async function GET(req: Request) {
  // Password gate (TECH-SPEC §13): un-gated, /api/ingest is a free fetcher — guard it.
  const denied = requireAuth(req);
  if (denied) return denied;

  const { searchParams } = new URL(req.url);
  const rawUrl = searchParams.get("url");

  // 1. Validate URL
  if (!rawUrl) {
    return err422("missing-url");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return err422("invalid-url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return err422("invalid-protocol");
  }

  if (isPrivateOrLocalhost(parsed.hostname)) {
    return err422("private-ip");
  }

  // 2. Fetch
  let upstream: Response;
  try {
    upstream = await fetch(rawUrl, {
      headers: {
        "user-agent": CHROME_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } catch (e) {
    return err422("fetch-failed");
  }

  const finalUrl = upstream.url || rawUrl;

  // 3a. Non-2xx
  if (!upstream.ok) {
    return err422("upstream-error");
  }

  // 3b. Content-type not html
  const ct = upstream.headers.get("content-type") ?? "";
  if (!ct.includes("html")) {
    return err422("not-html");
  }

  // 3c. Body too large
  const reader = upstream.body?.getReader();
  if (!reader) return err422("no-body");

  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalSize += value.length;
    if (totalSize > MAX_BODY) {
      return err422("too-large");
    }
    chunks.push(value);
  }

  const bodyBytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.length;
  }

  const html = new TextDecoder().decode(bodyBytes);

  // 3d. Bot-wall markers
  for (const marker of BOT_WALL_MARKERS) {
    if (html.includes(marker)) {
      return err422("bot-wall");
    }
  }

  // 4. Parse + rewrite
  const root = parse(html);

  // Remove <meta http-equiv="Content-Security-Policy">
  root.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((m) => m.remove());
  root.querySelectorAll('meta[http-equiv="content-security-policy"]').forEach((m) => m.remove());

  // Strip third-party experimentation scripts
  root.querySelectorAll("script[src]").forEach((s) => {
    const src = s.getAttribute("src") ?? "";
    if (EXPERIMENT_SCRIPT_PATTERN.test(src)) {
      s.remove();
    }
  });
  // Also strip inline experiment scripts
  root.querySelectorAll("script:not([src])").forEach((s) => {
    const content = s.textContent ?? "";
    if (EXPERIMENT_SCRIPT_PATTERN.test(content)) {
      s.remove();
    }
  });

  // Inject <base href="finalUrl"> as FIRST child of <head>
  const head = root.querySelector("head");
  if (head) {
    const base = `<base href="${finalUrl}">`;
    head.set_content(base + head.innerHTML);
  } else {
    // No head — create a minimal one
    const htmlEl = root.querySelector("html");
    if (htmlEl) {
      htmlEl.set_content(`<head><base href="${finalUrl}"></head>` + htmlEl.innerHTML);
    }
  }

  // Inject runtime before </body>. `window.__overlayTargetHost` carries the ORIGINAL target
  // hostname (e.g. "maxtechera.dev") through to the runtime: the page is served same-origin
  // from OUR host (via the <base href> rewrite above), so `location.hostname` inside the iframe
  // is always our own origin, never the target's — profiles.ts (PRD §4.2 ladder rung 1) is
  // keyed by the target hostname, so the runtime needs this out-of-band (see lib/runtime.ts's
  // "extract" handler).
  const targetHostname = (() => {
    try {
      return new URL(finalUrl).hostname;
    } catch {
      return "";
    }
  })();
  const body = root.querySelector("body");
  const runtimeScript = `<script>window.__overlayTargetHost=${JSON.stringify(targetHostname)};</script><script>\n${runtimeCode}\n</script>`;
  if (body) {
    body.set_content(body.innerHTML + runtimeScript);
  } else {
    // No body — append to end
    root.set_content(root.innerHTML + runtimeScript);
  }

  return new Response(root.toString(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Explicitly NO X-Frame-Options / CSP — we need iframing to work
    },
  });
}
