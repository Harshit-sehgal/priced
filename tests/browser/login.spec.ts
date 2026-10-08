import { expect, test } from "@playwright/test";

test("login offers Google without unverified email magic links", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByLabel(/email · magic link/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /send login link/i })).toHaveCount(0);
});
