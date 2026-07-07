// Throwaway fidelity spike: does "fetch + strip CSP meta + <base href> + serve same-origin"
// render real sites acceptably in an iframe? Run: node scripts/proxy-spike.mjs (port 4600)
import http from "node:http";
import { parse } from "node-html-parser";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function ingest(url) {
  const res = await fetch(url, {
    headers: { "user-agent": CHROME_UA, accept: "text/html,*/*" },
    redirect: "follow",
  });
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  if (!res.ok) return { error: `upstream ${res.status}`, status: res.status, body: body.slice(0, 300) };
  if (!ct.includes("html")) return { error: `not html: ${ct}` };
  if (/cf-chl|challenge-platform|Just a moment/i.test(body)) return { error: "bot-wall" };
  const root = parse(body);
  root.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((n) => n.remove());
  const head = root.querySelector("head");
  head?.insertAdjacentHTML("afterbegin", `<base href="${res.url}">`);
  // marker so we can verify our HTML is what rendered
  root.querySelector("body")?.insertAdjacentHTML(
    "beforeend",
    `<script>window.__OVERLAY_SPIKE__=1;document.addEventListener("click",e=>{const a=e.target&&e.target.closest&&e.target.closest("a");if(a)e.preventDefault()},true)</script>`
  );
  return { html: root.toString() };
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost:4600");
    const target = u.searchParams.get("url");
    try {
      if (u.pathname === "/ingest" && target) {
        const out = await ingest(target);
        if (out.error) {
          res.writeHead(422, { "content-type": "application/json" });
          return res.end(JSON.stringify(out));
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(out.html);
      }
      if (u.pathname === "/frame" && target) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(
          `<!doctype html><body style="margin:0"><iframe src="/ingest?url=${encodeURIComponent(
            target
          )}" style="width:100vw;height:100vh;border:0"></iframe></body>`
        );
      }
      res.writeHead(404).end("404");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  })
  .listen(4600, () => console.log("spike on :4600"));
