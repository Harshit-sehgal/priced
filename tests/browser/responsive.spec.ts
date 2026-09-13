import { expect, test, type Page } from "@playwright/test";
import { handleFor, uniqueDomain } from "./helpers";

/**
 * Device/state coverage (launch item 11). The suite projects are Desktop
 * Chrome + Pixel 7; this file pins explicit viewports per block (375px,
 * 430px, tablet) so small phones and tablets are covered without multiplying
 * the whole suite's project matrix. `test.use` viewport overrides apply in
 * both projects, so every assertion below is viewport-exact.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dims.scrollWidth, "no horizontal page overflow").toBeLessThanOrEqual(dims.innerWidth);
}

/** Long but eligible label (~50 chars) to stress wrapping/truncation. */
function longDomain(): string {
  return `ipt${Date.now().toString(36)}${"a".repeat(40)}.com`;
}

test.describe("375px phone", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("homepage renders premise, search and market without overflow", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("internet worth");
    await expect(page.getByRole("search")).toBeVisible();
    await expect(page.getByRole("link", { name: /openai\.com/ }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("long unclaimed domain wraps and keeps its CTA", async ({ page }) => {
    const domain = longDomain();
    await page.goto(`/domain/${domain}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(domain);
    await expect(page.getByText("Nobody holds this tag yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Claim for \$5/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("large holder price ($4,280) fits without overflow", async ({ page }) => {
    await page.goto("/domain/google.com");
    await expect(page.getByText("$4,280", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Take it for/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("full claim loop + receipt fits at 375px", async ({ page }) => {
    const domain = longDomain();
    await handleFor(page.request);
    await page.goto(`/domain/${domain}`);
    await page.getByRole("button", { name: /Claim for \$5/ }).click();
    await expect(page).toHaveURL(/\/takeover\//);
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await expect(page).toHaveURL(/\/checkout\/mock/);
    await page.getByRole("button", { name: "Pay (succeed)" }).click();
    await expect(page).toHaveURL(/\/success\//, { timeout: 10_000 });
    await expect(page.getByText("Held by @smoketest")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy post" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("430px phone", () => {
  test.use({ viewport: { width: 430, height: 932 } });

  test("homepage and long domain fit without overflow", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("search")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const domain = longDomain();
    await page.goto(`/domain/${domain}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(domain);
    await expect(page.getByRole("button", { name: /Claim for \$5/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("claimed domain with large price fits without overflow", async ({ page }) => {
    await page.goto("/domain/google.com");
    await expect(page.getByText("$4,280", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Tag History")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("homepage market and tables fit without overflow", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("internet worth");
    await expect(page.getByRole("heading", { name: "Most Fought Over" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("claimed domain page fits without overflow", async ({ page }) => {
    await page.goto("/domain/openai.com");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("openai.com");
    await expect(page.getByText("$940", { exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("unclaimed long domain fits without overflow", async ({ page }) => {
    const domain = longDomain();
    await page.goto(`/domain/${domain}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(domain);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("long domain through the loop", () => {
  test("claimed long domain page keeps holder chip and CTA usable", async ({ page }) => {
    // Runs at the project default viewport; overflow matrix above covers sizes.
    const domain = uniqueDomain();
    await handleFor(page.request);
    await page.goto(`/domain/${domain}`);
    await page.getByRole("button", { name: /Claim for \$5/ }).click();
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.getByRole("button", { name: "Pay (succeed)" }).click();
    await expect(page).toHaveURL(/\/success\//, { timeout: 10_000 });
    await page.getByRole("link", { name: "Defend it · view the tag" }).click();
    await expect(page).toHaveURL(new RegExp(`/domain/${domain}$`));
    await expect(page.getByText("@smoketest").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Take it for \$10/ })).toBeVisible();
  });
});

test.describe("states QA (§17)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("reserved domain shows the unavailable state without overflow", async ({ page }) => {
    await page.goto("/domain/fbi.gov");
    await expect(page.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("reserved by the operator")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("invalid domain shows the error state without overflow", async ({ page }) => {
    await page.goto("/domain/not a domain");
    await expect(page.getByText("That's not a domain we can price.")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  // A raw percent-escape used to make decodeURIComponent throw a URIError and
  // 500 the page. Both public param routes must render their not-found state.
  test("malformed percent-encoded params render the error states, never 500", async ({ page }) => {
    await page.goto("/domain/%25");
    await expect(page.getByText("That's not a domain we can price.")).toBeVisible();
    await page.goto("/u/%25");
    await expect(page.getByText("That handle doesn't exist here.")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("expired/stale quote state fits without overflow", async ({ page }) => {
    await page.goto("/takeover/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Quote not found.");
    await expectNoHorizontalOverflow(page);
  });

  test("unknown receipt state fits without overflow", async ({ page }) => {
    await page.goto("/success/00000000-0000-4000-8000-000000000000");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Receipt not found.");
    await expectNoHorizontalOverflow(page);
  });

  test("logged-out homepage exposes login and the market", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
    await expect(page.getByRole("link", { name: /openai\.com/ }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
