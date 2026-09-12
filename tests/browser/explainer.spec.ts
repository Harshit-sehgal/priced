import { expect, test, type Page } from "@playwright/test";

/**
 * The premise and the legal pages.
 *
 * Most inbound traffic lands on a shared tag or receipt link, never the
 * homepage hero, so "what is this?" has to be reachable from every page. These
 * pages are also the ones that carry the disclaimers, so a silent rendering or
 * layout break here is a compliance problem, not a cosmetic one.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dims.scrollWidth, "no horizontal page overflow").toBeLessThanOrEqual(dims.innerWidth);
}

const LEGAL_PAGES = [
  { path: "/about", heading: /price tag/i },
  { path: "/terms", heading: /Terms of Service/i },
  { path: "/privacy", heading: /Privacy Policy/i },
  { path: "/refunds", heading: /Refund Policy/i },
];

test.describe("explainer and legal pages", () => {
  for (const { path, heading } of LEGAL_PAGES) {
    test(`${path} renders with its heading`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(heading);
      await expectNoHorizontalOverflow(page);
    });
  }

  test("the premise is reachable from a deep page, not just the homepage", async ({ page }) => {
    await page.goto("/domain/openai.com");
    const link = page.getByRole("link", { name: /what is this/i });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/about/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  // The disclaimer is the single most important sentence on the site: it is
  // what separates a joke from a claim of ownership. It must survive on every
  // page, not only where someone remembered to add it.
  test("every page carries the 'not the actual domain' disclaimer", async ({ page }) => {
    for (const path of ["/", "/about", "/terms", "/domain/openai.com"]) {
      await page.goto(path);
      await expect(
        page.getByText(/not the actual domain/i).first(),
        `${path} must disclaim ownership`,
      ).toBeVisible();
    }
  });

  test("about page states the payout rule and the price rule", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByText(/you receive/i).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /price only goes one way/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Nobody gets paid out/i })).toBeVisible();
  });

  test("legal pages cross-link so a reader can reach all of them", async ({ page }) => {
    await page.goto("/terms");
    await expect(page.getByRole("link", { name: /Privacy/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Refunds/i }).first()).toBeVisible();
  });
});

test.describe("375px phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  for (const { path } of LEGAL_PAGES) {
    test(`${path} fits without overflow at 375px`, async ({ page }) => {
      await page.goto(path);
      await expectNoHorizontalOverflow(page);
    });
  }
});
