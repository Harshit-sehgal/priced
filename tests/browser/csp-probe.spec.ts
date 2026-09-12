import { test, expect } from "@playwright/test";

// A Report-Only policy is only useful if it is SATISFIED today — otherwise
// every page load reports and the signal is worthless. This asserts that.
const PAGES = ["/", "/about", "/terms", "/privacy", "/refunds", "/login", "/domain/google.com", "/welcome"];

test("report-only CSP produces no violations on any key page", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    const t = msg.text();
    if (/Content Security Policy|Report Only|report-only/i.test(t)) violations.push(t.slice(0, 240));
  });
  for (const p of PAGES) {
    await page.goto(p, { waitUntil: "networkidle" }).catch(() => {});
  }
  if (violations.length) console.log("VIOLATIONS:\n" + violations.join("\n"));
  expect(violations, `report-only CSP must be satisfied; got:\n${violations.join("\n")}`).toHaveLength(0);
});
