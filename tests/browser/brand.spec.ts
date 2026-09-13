import { expect, test } from "@playwright/test";
import { handleFor } from "./helpers";

/**
 * Priced brand migration (§4): public surfaces must carry the new name and
 * must not carry the old one. OG image routes serve PNGs (rendered by
 * next/og with the PRICED header inside).
 */
test.describe("Priced branding", () => {
  test("header shows the Priced wordmark", async ({ page }) => {
    await page.goto("/");
    const wordmark = page.locator(".wordmark");
    await expect(wordmark).toHaveText(/priced/i);
    await expect(wordmark).not.toContainText("Internet");
  });

  test("homepage hero says Priced, never the old name", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".eyebrow").first()).toHaveText("Priced");
    const body = page.locator("body");
    await expect(body).not.toContainText("Internet Price Tag");
  });

  test("domain page metadata copy references Priced", async ({ page }) => {
    await page.goto("/domain/openai.com");
    await expect(page.locator(".eyebrow").first()).toHaveText(/Priced tag/i);
    await expect(page.locator("body")).not.toContainText("Internet Price Tag");
  });

  test("takeover confirm copy references Priced", async ({ page }) => {
    // Any quote id: the not-found state itself is public copy. Assert the
    // positive heading too — a bare "not the old name" also passes on a 500.
    await page.goto("/takeover/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Quote not found.");
    await expect(page.locator("body")).not.toContainText("Internet Price Tag");
  });

  test("success receipt copy references Priced", async ({ page }) => {
    await page.goto("/success/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Receipt not found");
    await expect(page.locator("body")).not.toContainText("Internet Price Tag");
  });

  test("holder profile copy references Priced", async ({ page }) => {
    await handleFor(page.request);
    await page.goto("/u/smoketest");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("@smoketest");
    await expect(page.locator("body")).not.toContainText("Internet Price Tag");
  });

  test("legal pages reference Priced", async ({ page }) => {
    const headings: Record<string, RegExp> = {
      "/terms": /Terms of Service/i,
      "/privacy": /Privacy Policy/i,
      "/refunds": /Refund Policy/i,
    };
    for (const [path, heading] of Object.entries(headings)) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      await expect(page.locator("body")).not.toContainText("Internet Price Tag");
    }
  });

  test("OG card renders for a claimed demo domain", async ({ request }) => {
    const res = await request.get("/domain/openai.com/opengraph-image");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  });
});
