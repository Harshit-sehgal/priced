import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Priced: how much is the internet worth?";

const appHost = process.env.NEXT_PUBLIC_APP_URL
  ? new URL(process.env.NEXT_PUBLIC_APP_URL).host
  : "priced.game";

// Static card for the homepage and any page without its own image. Same
// palette as the domain card so unfurls read as one brand.
export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f4f1ea",
          color: "#16150f",
          padding: 64,
          fontFamily: "monospace",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, letterSpacing: 4, color: "#615d4e" }}>
          <span style={{ color: "#16150f", fontWeight: 700 }}>PRICED</span>
          <span>NOT THE ACTUAL DOMAIN</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 96, fontWeight: 700, lineHeight: 1.05 }}>How much is the internet worth?</div>
          <div style={{ fontSize: 34, color: "#615d4e" }}>
            Every domain has a price tag. Pay more and it shows your handle.
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26, borderTop: "4px solid #16150f", paddingTop: 20 }}>
          <span style={{ color: "#0a5c3d", fontWeight: 700 }}>FIRST CLAIM $5</span>
          <span>{appHost}</span>
        </div>
      </div>
    ),
    size,
  );
}
