import { test, expect } from "@playwright/test";

// A Report-Only policy is only useful if it is SATISFIED today — otherwise
// every page load reports and the signal is worthless. This asserts that.
const PAGES = ["/", "/about", "/terms", "/privacy", "/refunds", "/login", "/domain/google.com", "/welcome"];

test("report-only CSP produces no violations on any key page", async ({ page }) => {
  const violations: string[] = [];
  const navErrors: string[] = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (/Content Security Policy|Report Only|report-only/i.test(t)) violations.push(t.slice(0, 240));
  });
  for (const p of PAGES) {
    try {
      const response = await page.goto(p, { waitUntil: "networkidle" });
      // page.goto resolves on HTTP 4xx/5xx, so the status must be checked or a
      // page returning 500 (the documented outage) contributes no violation
      // and the probe passes vacuously.
      if (!response || response.status() >= 400) {
        navErrors.push(`${p}: HTTP ${response?.status() ?? "no response"}`);
      }
    } catch (e) {
      navErrors.push(`${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (violations.length) console.log("VIOLATIONS:\n" + violations.join("\n"));
  expect(navErrors, `pages failed to load:\n${navErrors.join("\n")}`).toHaveLength(0);
  expect(violations, `report-only CSP must be satisfied; got:\n${violations.join("\n")}`).toHaveLength(0);
});
