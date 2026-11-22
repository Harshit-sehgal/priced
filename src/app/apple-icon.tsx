import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#16150f",
          color: "#f4f1ea",
          fontFamily: "monospace",
          fontSize: 120,
          fontWeight: 700,
        }}
      >
        P<span style={{ color: "#2fbf7f" }}>.</span>
      </div>
    ),
    size,
  );
}
