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
    command: "pnpm dev",
    url: "http://localhost:3010",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
