/**
 * e2e/m-gate.spec.ts — issue #12 / TECH-SPEC §13 password gate. All @smoke (keyless):
 * proves the gate against a REAL server booted WITH APP_PASSWORD (port 3011, reusing the build
 * the main webServer already produced), plus gate-OFF behavior on the default server (3010,
 * APP_PASSWORD unset). No ANTHROPIC key needed — a 401 is decided before any upstream call.
 */

import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";

const GATE_PORT = Number(process.env.GATE_PORT ?? 3099);
const GATE_URL = `http://localhost:${GATE_PORT}`;
const PASSWORD = "testpw-gate-42";

let server: ChildProcess | null = null;

async function waitForServer(url: string, timeoutMs = 60_000) {
  const ctx = await pwRequest.newContext();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await ctx.get(`${url}/api/auth`, { timeout: 2_000 });
      if (r.status() < 500) {
        await ctx.dispose();
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 1_000));
  }
  await ctx.dispose();
  throw new Error(`gate server never became ready on ${url}`);
}

test.beforeAll(async () => {
  // Reuse the .next build the main webServer already produced; just start a SECOND instance with
  // the gate enabled on a distinct port. `next start` reads APP_PASSWORD from the spawn env.
  server = spawn(join(process.cwd(), "node_modules/.bin/next"), ["start", "-p", String(GATE_PORT)], {
    env: { ...process.env, APP_PASSWORD: PASSWORD },
    stdio: "ignore",
  });
  await waitForServer(GATE_URL);
});

test.afterAll(async () => {
  server?.kill("SIGKILL");
});

// ── Gate ON (APP_PASSWORD set) ──────────────────────────────────────────────────

test("gate on · no cookie → every protected API route 401s @smoke", async () => {
  const ctx = await pwRequest.newContext({ baseURL: GATE_URL });
  const ingest = await ctx.get(`/api/ingest?url=${encodeURIComponent("https://example.com")}`);
  expect(ingest.status(), "/api/ingest without cookie must 401").toBe(401);
  const anthropic = await ctx.post(`/api/anthropic/v1/messages`, { data: {} });
  expect(anthropic.status(), "/api/anthropic without cookie must 401 (never reaches the key)").toBe(401);
  // M4 (#4) / PR #41 review (NIT B): the new memory route must be in the gate's coverage too.
  const memory = await ctx.get(`/api/memory?site=example.com`);
  expect(memory.status(), "/api/memory without cookie must 401").toBe(401);
  await ctx.dispose();
});

test("gate on · GET /api/auth reports locked before login @smoke", async () => {
  const ctx = await pwRequest.newContext({ baseURL: GATE_URL });
  const r = await ctx.get(`/api/auth`);
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ gateEnabled: true, authed: false });
  await ctx.dispose();
});

test("gate on · wrong password → 401, no cookie @smoke", async () => {
  const ctx = await pwRequest.newContext({ baseURL: GATE_URL });
  const r = await ctx.post(`/api/auth`, { data: { password: "not-the-password" } });
  expect(r.status()).toBe(401);
  expect(r.headers()["set-cookie"], "no cookie on a failed attempt").toBeFalsy();
  await ctx.dispose();
});

test("gate on · correct password → httpOnly cookie → protected routes pass @smoke", async () => {
  const ctx: APIRequestContext = await pwRequest.newContext({ baseURL: GATE_URL });

  const login = await ctx.post(`/api/auth`, { data: { password: PASSWORD } });
  expect(login.status()).toBe(200);
  const setCookie = login.headers()["set-cookie"] ?? "";
  expect(setCookie).toContain("overlay-auth=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Lax");

  // The context now carries the cookie — the gate lets the request through (422 for the bad
  // example.com fetch is fine; the point is it's NOT 401 anymore).
  const ingest = await ctx.get(`/api/ingest?url=${encodeURIComponent("https://example.com")}`);
  expect(ingest.status(), "authed request must clear the gate (not 401)").not.toBe(401);

  // M4 (#4) / PR #41 review (NIT B): /api/memory too.
  const memory = await ctx.get(`/api/memory?site=example.com`);
  expect(memory.status(), "authed /api/memory request must clear the gate (not 401)").not.toBe(401);

  const status = await ctx.get(`/api/auth`);
  expect(await status.json()).toEqual({ gateEnabled: true, authed: true });
  await ctx.dispose();
});

test("gate on · the password never appears in the served HTML or bundle @smoke", async () => {
  const ctx = await pwRequest.newContext({ baseURL: GATE_URL });
  await ctx.post(`/api/auth`, { data: { password: PASSWORD } });
  const html = await (await ctx.get(`/`)).text();
  expect(html.includes(PASSWORD), "password must never be embedded client-side").toBe(false);
  await ctx.dispose();
});

// ── Gate OFF (default server, APP_PASSWORD unset) ────────────────────────────────

test("gate off · everything works with no cookie (local dev unchanged) @smoke", async ({ request }) => {
  // The default webServer runs WITHOUT APP_PASSWORD — use the config-bound `request` fixture so
  // this is port-agnostic (works in CI on 3010 and any isolated local port).
  const status = await request.get(`/api/auth`);
  expect(await status.json()).toEqual({ gateEnabled: false, authed: true });
  const ingest = await request.get(`/api/ingest?url=${encodeURIComponent("https://example.com")}`);
  expect(ingest.status(), "gate off → ingest not blocked").not.toBe(401);
});
