import type { Metadata } from "next";
import { LoginClient } from "./login-client";

// The proxy refreshes the Supabase session (and therefore reads cookies) on
// every matched route. OpenNext refuses to serve a page whose prerendered HTML
// claims static but whose request-time render touches cookies — the
// "static to dynamic at runtime" error, which 500'd /login on the Workers beta.
// Force dynamic rendering so the route is honest about what it does.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return <LoginClient />;
}
