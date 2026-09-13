import type { Metadata } from "next";
import { MockCheckoutClient } from "./mock-checkout-client";

// See src/app/login/page.tsx: OpenNext 500s a prerendered page that the
// middleware forces dynamic at request time (cookie read). Demo checkout is
// never statically useful, so render it dynamically.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Demo checkout", robots: { index: false } };

export default function MockCheckoutPage() {
  return <MockCheckoutClient />;
}
