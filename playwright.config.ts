import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
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
