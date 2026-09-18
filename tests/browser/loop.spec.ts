import { expect, test } from "@playwright/test";
import { handleFor, uniqueDomain } from "./helpers";

test.describe("full takeover loop (demo mode)", () => {
  test("search → claim → quote → mock payment → receipt → share", async ({ page }) => {
    const domain = uniqueDomain();
    await handleFor(page.request); // demo buyer needs a handle before quoting

    // Search anonymously.
    await page.goto("/");
    await page.getByRole("search").getByLabel("Domain").fill(domain);
    await page.getByRole("search").getByRole("button", { name: "Price it" }).click();
    await expect(page).toHaveURL(new RegExp(`/domain/${domain}$`));

    // Unclaimed state and the $5 minimum offer.
    await expect(page.getByText("Nobody holds this tag yet.")).toBeVisible();
    await page.getByRole("button", { name: "Continue with this offer" }).click();

    // Server-authoritative quote confirmation page.
    await expect(page).toHaveURL(/\/takeover\//);
    await expect(page.getByText("First claim. You choose the opening price.")).toBeVisible();
    await expect(page.getByText("You are buying:")).toBeVisible();

    // Demo checkout (drives the real signed-webhook path).
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await expect(page).toHaveURL(/\/checkout\/mock/);
    await expect(page.getByText("Simulated payment")).toBeVisible();
    await page.getByRole("button", { name: "Pay (succeed)" }).click();

    // Receipt/share destination.
    await expect(page).toHaveURL(/\/success\//, { timeout: 10_000 });
    await expect(page.getByText("Held by @smoketest")).toBeVisible();
    await expect(page.getByText("symbolic holder status only. Not the actual domain.")).toBeVisible();

    // Share artifacts (§36).
    await expect(page.getByRole("button", { name: new RegExp(`Post on X · I just took ${domain}`) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy post" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();

    // Market now shows the new holder; challenger loop is visible.
    await page.getByRole("link", { name: "Defend it · view the tag" }).click();
    await expect(page).toHaveURL(new RegExp(`/domain/${domain}$`));
    await expect(page.getByText("@smoketest").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with this offer" })).toBeVisible();
  });

  test("declined payment keeps the tag unclaimed", async ({ page }) => {
    const domain = uniqueDomain();
    await handleFor(page.request);

    await page.goto(`/domain/${domain}`);
    await page.getByRole("button", { name: "Continue with this offer" }).click();
    await expect(page).toHaveURL(/\/takeover\//);
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await expect(page).toHaveURL(/\/checkout\/mock/);

    await page.getByRole("button", { name: "Simulate decline" }).click();
    await expect(page.getByText("Payment declined (simulated). No money moved.")).toBeVisible();

    // No sale must exist: domain stays unclaimed.
    await page.goto(`/domain/${domain}`);
    await expect(page.getByText("Nobody holds this tag yet.")).toBeVisible();
  });
});

test.describe("holder profiles (/u/[handle])", () => {
  test("profile shows current holdings and takeover history after a claim", async ({ page }) => {
    const domain = uniqueDomain();
    await handleFor(page.request);

    await page.goto(`/domain/${domain}`);
    await page.getByRole("button", { name: "Continue with this offer" }).click();
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.getByRole("button", { name: "Pay (succeed)" }).click();
    await expect(page).toHaveURL(/\/success\//, { timeout: 10_000 });

    await page.goto("/u/smoketest");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("@smoketest");
    // Both projects run concurrently, so the count may include the other's claim.
    await expect(page.getByText(/Holds \d+ tags?/)).toBeVisible();
    // Domain appears in both the holdings and history lists.
    await expect(page.getByRole("link", { name: domain }).first()).toBeVisible();
    await expect(page.getByText("first claim").first()).toBeVisible();
  });

  test("unknown handle shows the empty state", async ({ page }) => {
    // Use a handle that never appears in the demo seed or smoketest flow.
    // (The seed now includes real profile-like entries, so latentspace is taken.)
    const ghost = `ghost${Date.now().toString(36).slice(-6)}`;
    await page.goto(`/u/${ghost}`);
    await expect(page.getByText("holds nothing yet")).toBeVisible();
  });
});

test.describe("mobile viewport (§32)", () => {
  test("domain page surfaces holder, price and CTA without hunting", async ({ page }) => {
    // Runs in the Pixel 7 project; the desktop project also exercises this page.
    test.skip(page.viewportSize()?.width !== 412, "mobile-only check");
    await page.goto("/domain/openai.com");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("openai.com");
    await expect(page.getByText("@latentspace").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with this offer" })).toBeVisible();
    // CTA is comfortably within the first two viewports.
    const cta = page.getByRole("button", { name: "Continue with this offer" });
    await expect(cta).toBeInViewport({ ratio: 0.5 });
  });
});
