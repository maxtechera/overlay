import { test, expect } from "@playwright/test";

// Tag conventions (CLAUDE.md → The harness):
//   @mN    — encodes milestone N's pass from PRD §7 (added by the PR that closes it)
//   @ai    — needs ANTHROPIC_API_KEY; must skip cleanly when it's absent
//   @smoke — always runs, keyless

test("shell renders @smoke", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overlay" })).toBeVisible();
});

test("ai specs skip cleanly without a key @smoke", async () => {
  test.skip(!process.env.ANTHROPIC_API_KEY, "no ANTHROPIC_API_KEY — @ai specs skip like this");
  expect(process.env.ANTHROPIC_API_KEY).toBeTruthy();
});
