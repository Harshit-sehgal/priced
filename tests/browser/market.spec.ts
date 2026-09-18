import { expect, test } from "@playwright/test";

test.describe("homepage and discovery", () => {
  test("market renders with premise, search and prices", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("internet worth");
    await expect(page.getByRole("search")).toBeVisible();
    // Demo market rows show domain, holder and price.
    await expect(page.getByRole("link", { name: /openai\.com/ }).first()).toBeVisible();
    // On narrow viewports the holder cell can be display:none; assert existence.
    await expect(page.locator(".cell-holder", { hasText: "latentspace" }).first()).toBeAttached();
  });

  test("search normalizes a pasted URL to the domain page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("search").getByLabel("Domain").fill("https://www.GitHub.com/explore?tab=trending");
    await page.getByRole("search").getByRole("button", { name: "Price it" }).click();
    await expect(page).toHaveURL(/\/domain\/github\.com$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("github.com");
  });

  test("recent activity feed shows takeover entries", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/took\s+/).first()).toBeVisible();
  });

  test("most-fought-over module renders contested domains or the empty state", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Most Fought Over" })).toBeVisible();
    // Demo seed has no multi-sale domains; either state is valid.
    const contested = page.locator(".market-table").nth(1); // second table on the page
    const empty = page.getByText("Nothing has been fought over yet");
    await expect(contested.or(empty).first()).toBeVisible();
  });
});

test.describe("unclaimed domain experience", () => {
  test("unclaimed domain shows $5 first claim and disclaimer", async ({ page }) => {
    await page.goto("/domain/figma.com");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("figma.com");
    await expect(page.getByText("Nobody holds this tag yet.")).toBeVisible();
    await expect(page.getByText("Minimum first claim", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Your offer for figma.com")).toHaveValue("5.00");
    await expect(page.getByRole("button", { name: "Continue with this offer" })).toBeVisible();
    await expect(page.getByText("You are not buying the domain")).toBeVisible();
  });

  test("invalid domain input is rejected by the server", async ({ page }) => {
    await page.goto("/domain/not a domain");
    await expect(page.getByText("That's not a domain we can price.")).toBeVisible();
    // A link back to the market keeps the visitor un-stuck.
    await expect(page.getByRole("link", { name: "Back to the market" })).toBeVisible();
  });
});

test.describe("claimed domain page", () => {
  test("shows holder, price, transparent math and history", async ({ page }) => {
    await page.goto("/domain/openai.com");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("openai.com");
    await expect(page.locator(".holder-chip", { hasText: "latentspace" })).toBeVisible();
    // money() formats whole dollars without decimals ($940, not $940.00).
    await expect(page.getByText("$940", { exact: true }).first()).toBeVisible();
    // Takeover math transparency (§11).
    await expect(page.getByText("1% of current")).toBeVisible();
    await expect(page.getByText("Minimum increase")).toBeVisible();
    await expect(page.getByLabel("Your offer for openai.com")).toHaveValue("949.40");
    await expect(page.getByRole("button", { name: "Continue with this offer" })).toBeVisible();
    // History ledger exists (seeded demo history).
    await expect(page.getByText("Tag History")).toBeVisible();
  });
});

test.describe("reduced motion", () => {
  test("page is usable with animations disabled", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/domain/openai.com");
    await expect(page.getByRole("button", { name: "Continue with this offer" })).toBeEnabled();
  });
});
