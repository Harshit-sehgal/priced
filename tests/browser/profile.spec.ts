import { expect, test } from "@playwright/test";
import { handleFor } from "./helpers";

/**
 * Holder profile surface (§6/§7/§10, demo mode): the demo buyer can edit
 * their bio + CTA, the CTA renders on their profile, and the analytics page
 * shows the honest demo empty state.
 */
test.describe("holder profile", () => {
  test("demo holder can set a bio and CTA, then sees them on the profile", async ({ page }) => {
    await handleFor(page.request);
    await page.goto("/u/smoketest");

    // Open the editor (own profile in demo mode).
    await page.getByRole("button", { name: "Edit profile" }).click();

    const bio = `holding tags since ${Date.now().toString(36)}`;
    await page.getByLabel(/Short bio/).fill(bio);
    await page.getByLabel(/CTA label/).fill("Visit my startup");
    await page.getByLabel(/CTA link/).fill("https://example.com");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    // Profile now shows bio + CTA (the paragraph, not the editor textarea).
    await expect(page.locator("p.muted", { hasText: bio })).toBeVisible();
    const primaryCta = page.locator("a.btn.btn-take", { hasText: "Visit my startup" }).first();
    await expect(primaryCta).toHaveAttribute("href", "https://example.com/");
    // Safe external link behavior.
    await expect(primaryCta).toHaveAttribute("rel", /noopener/);
    await expect(primaryCta).toHaveAttribute("target", "_blank");
  });

  test("CTA validation rejects http and non-URLs inline", async ({ page }) => {
    await handleFor(page.request);
    await page.goto("/u/smoketest");
    await page.getByRole("button", { name: "Edit profile" }).click();

    await page.getByLabel(/CTA label/).fill("Bad link");
    await page.getByLabel(/CTA link/).fill("http://not-secure.com");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Use a full https:// URL.")).toBeVisible();

    await page.getByLabel(/CTA link/).fill("just-text");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Use a full https:// URL.")).toBeVisible();
  });

  test("analytics page shows the honest demo empty state for the owner", async ({ page }) => {
    await handleFor(page.request);
    await page.goto("/u/smoketest/analytics");
    // Demo mode: no datastore, so the page says so instead of showing zeros
    // that pretend to be data.
    await expect(
      page.getByText(/No datastore configured|No traffic yet/),
    ).toBeVisible();
  });

  test("analytics page is private to non-owners", async ({ page }) => {
    // Load the homepage first so the demo market (and the seeded @indexfund
    // profile) exists independently of test order. @indexfund's profile id is
    // demo-indexfund, which is NOT the demo buyer (demo-user), so the owner
    // gate must refuse — a real check, unlike the old nonexistent-handle case
    // where every accepted string was an unrelated state.
    await page.goto("/");
    await page.goto("/u/indexfund/analytics");
    await expect(page.getByText("Not your analytics.")).toBeVisible();
  });
});
