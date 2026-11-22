import { expect, test } from "@playwright/test";
import { confirmAdultAndContinue, handleFor, uniqueDomain } from "./helpers";

/**
 * Buyer-protection UX around the money path (demo mode): a quote the market
 * has moved past is refused before payment, fat-fingered offers need a second
 * click, and natural amount formats parse.
 */
test.describe("checkout guards", () => {
  test("a quote overtaken by another payment is refused before checkout", async ({ page }) => {
    await handleFor(page.request);
    const domain = uniqueDomain();
    const quote = async (amountCents: number) => {
      const res = await page.request.post("/api/quotes", { data: { domain, amountCents } });
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { quoteId: string }).quoteId;
    };
    const first = await quote(500);
    const second = await quote(600);

    await page.goto(`/takeover/${second}`);
    await confirmAdultAndContinue(page);
    await page.getByRole("button", { name: "Pay (succeed)" }).click();
    await expect(page).toHaveURL(/\/success\//, { timeout: 10_000 });

    await page.goto(`/takeover/${first}`);
    await expect(page.getByRole("heading", { name: "This tag changed hands." })).toBeVisible();
    const res = await page.request.post("/api/checkout", { data: { quoteId: first } });
    expect(res.status()).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("quote_stale");
  });

  test("a large offer needs a second click and accepts $ and commas", async ({ page }) => {
    await handleFor(page.request);
    const domain = uniqueDomain();
    await page.goto(`/domain/${domain}`);
    const input = page.getByLabel(`Your offer for ${domain}`);
    await input.fill("$1,000");
    await page.getByRole("button", { name: "Continue with this offer" }).click();
    await expect(page.getByText("Click again to confirm")).toBeVisible();
    await page.getByRole("button", { name: "Yes, offer $1,000" }).click();
    await expect(page).toHaveURL(/\/takeover\//);
    await expect(page.getByText("$1,000").first()).toBeVisible();
  });

  test("a search without a domain ending gets an inline hint", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Domain", { exact: true }).fill("hello");
    await page.getByRole("button", { name: "Price it" }).click();
    await expect(page.getByText("Add the ending, like hello.com.")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
});
