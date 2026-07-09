import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  // M4 (#4) / PR #41 round-2 review: clears `.memory/` once before the run so no spec's real
  // extraction (which triggers the debounced autosave) can leak state into another spec's
  // `.memory/<hostname>/` — see e2e/global-setup.ts for the full rationale.
  globalSetup: "./e2e/global-setup.ts",
  // Serialize on CI only: the <500ms apply criterion (PRD.md:497, TECH-SPEC.md:543)
  // measures a real client-side round-trip. On CI's 2-vCPU shared runner, 2 concurrent
  // Playwright workers contend for CPU, and a neighbor worker's test can starve the one
  // mid-measurement — inflating the number with cross-test noise a real user never sees
  // (a production apply has zero parallel-test contention). Full local parallelism is
  // unaffected (undefined → Playwright's default worker count).
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: "http://localhost:3010",
    screenshot: "on", // every test produces a screenshot — PR evidence, uploaded by CI
    video: "on", //     every test produces a video   — PR evidence, uploaded by CI
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    // Production build, not `next dev`: the M1a acceptance criterion (<500ms apply —
    // PRD.md:497, TECH-SPEC.md:543) measures real client-side latency. `next dev` serves
    // unminified bundles + dev-mode React, which is slow enough on a CPU-constrained CI
    // runner to blow the budget on infra overhead alone, not app logic. `pnpm build` runs
    // `prebuild` (scripts/build-runtime.mjs) first, so the iframe runtime is always fresh.
    command: "pnpm build && pnpm start",
    url: "http://localhost:3010",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
