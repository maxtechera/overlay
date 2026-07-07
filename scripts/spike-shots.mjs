// Screenshots: direct vs proxied-in-iframe, per test URL (needs playwright installed).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const URLS = {
  posthog: "https://posthog.com",
  maxtechera: "https://maxtechera.dev",
  astro: "https://astro.build",
};
const OUT = new URL("./shots", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

for (const [name, url] of Object.entries(URLS)) {
  for (const [mode, target] of [
    ["direct", url],
    ["proxied", `http://localhost:4600/frame?url=${encodeURIComponent(url)}`],
  ]) {
    try {
      await page.goto(target, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(3500);
      await page.screenshot({ path: `${OUT}/${name}-${mode}.png` });
      // check our marker actually runs inside the proxied iframe
      if (mode === "proxied") {
        const frame = page.frames().find((f) => f.url().includes("/ingest"));
        const marker = frame ? await frame.evaluate(() => window.__OVERLAY_SPIKE__).catch(() => null) : null;
        const heroText = frame
          ? await frame.evaluate(() => document.querySelector("h1")?.textContent?.slice(0, 80)).catch(() => null)
          : null;
        console.log(`${name} proxied: marker=${marker} h1=${JSON.stringify(heroText)}`);
      } else {
        console.log(`${name} direct: ok`);
      }
    } catch (e) {
      console.log(`${name} ${mode}: FAILED ${String(e).slice(0, 150)}`);
    }
  }
}
await browser.close();
