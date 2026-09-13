import type { Metadata } from "next";
import { WelcomeClient } from "./welcome-client";

// See src/app/login/page.tsx: the proxy's cookie read makes this route dynamic
// at request time, and OpenNext 500s a statically-prerendered page that does
// that. Force dynamic so it is served correctly.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Pick your handle" };

export default function WelcomePage() {
  return <WelcomeClient />;
}
