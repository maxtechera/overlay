import { test, expect } from "@playwright/test";

// Tag conventions (CLAUDE.md → The harness):
//   @mN    — encodes milestone N's pass from PRD §7 (added by the PR that closes it)
//   @ai    — needs ANTHROPIC_API_KEY; must skip cleanly when it's absent
//   @smoke — always runs, keyless

test("shell renders @smoke", async ({ page }) => {
  await page.goto("/");
  // The two-pane shell (M1a) renders the brand name in the topbar and the URL input
  await expect(page.getByTestId("url-input")).toBeVisible();
  // The brand name "over.lay" appears in the topbar
  await expect(page.locator(".brand")).toBeVisible();
  await expect(page.locator(".brand")).toContainText("lay");
});

test("ai specs skip cleanly without a key @smoke", async () => {
  test.skip(!process.env.ANTHROPIC_API_KEY, "no ANTHROPIC_API_KEY — @ai specs skip like this");
  expect(process.env.ANTHROPIC_API_KEY).toBeTruthy();
});
