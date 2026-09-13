import { expect, test } from "@playwright/test";
import { handleFor, uniqueDomain } from "./helpers";

/**
 * OG card smoke tests (launch item 13, in-repo half). next/og rendering only
 * runs inside the Next server, so these hit the real HTTP routes: both
 * opengraph-image endpoints must return valid PNGs for claimed, unclaimed
 * and missing entities. The X card validator itself remains an owner step.
 */
test.describe("OG cards", () => {
  test("claimed domain card renders a PNG", async ({ request }) => {
    const res = await request.get("/domain/google.com/opengraph-image");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect((await res.body()).length).toBeGreaterThan(1_000);
  });

  test("unclaimed domain card renders a PNG", async ({ request }) => {
    const res = await request.get(`/domain/${uniqueDomain()}/opengraph-image`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect((await res.body()).length).toBeGreaterThan(1_000);
  });

  test("receipt card renders a PNG for a real sale", async ({ page, request }) => {
    const domain = uniqueDomain();
    await handleFor(request);
    await page.goto(`/domain/${domain}`);
    await page.getByRole("button", { name: /Claim for \$5/ }).click();
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.getByRole("button", { name: "Pay (succeed)" }).click();
    await expect(page).toHaveURL(/\/success\//, { timeout: 10_000 });
    const saleId = page.url().match(/\/success\/([^/?#]+)/)?.[1];
    expect(saleId).toBeTruthy();

    const res = await request.get(`/success/${saleId}/opengraph-image`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect((await res.body()).length).toBeGreaterThan(1_000);
  });

  test("receipt card degrades gracefully for an unknown sale", async ({ request }) => {
    const res = await request.get("/success/00000000-0000-4000-8000-000000000000/opengraph-image");
    // getSale returns null → "receipt not found" card, never a 500.
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  });

  // Reserved domains are ineligible, and the strict money read (getDomain →
  // requireEligibleDomain) throws for them. The OG route used to call it anyway
  // and 500'd every unfurl of a reserved tag; it now renders a reserved card.
  test("reserved domain card renders a PNG instead of 500ing", async ({ request }) => {
    const res = await request.get("/domain/fbi.gov/opengraph-image");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect((await res.body()).length).toBeGreaterThan(1_000);
  });

  // A malformed percent-escape used to throw URIError → 500 before validation.
  test("malformed domain parameter renders the unknown card, never a 500", async ({ request }) => {
    const res = await request.get("/domain/%25/opengraph-image");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
  });
});
