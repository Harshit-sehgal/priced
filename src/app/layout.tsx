import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: {
    default: "Priced · every domain has a price",
    template: "%s · Priced",
  },
  description:
    "A public market where people pay to become the temporary symbolic holder of recognizable internet domains. Not the actual domains.",
  openGraph: {
    siteName: "Priced",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        <main className="shell" style={{ paddingTop: "var(--space-6)", paddingBottom: "var(--space-7)" }}>
          {children}
        </main>
        <footer className="site-footer">
          <div className="shell stack">
            <p className="small muted" style={{ margin: 0 }}>
              Every tag on this site is a symbolic status marker. Holders do not acquire the real
              domain, website, company, trademark, DNS control, or any right to represent the
              underlying entity. Prices are a game. <strong>Not the actual domain.</strong>
            </p>
            <nav className="footer-links small mono" aria-label="Legal">
              <a href="/about">What this is</a>
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy</a>
              <a href="/refunds">Refunds</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
