import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Free, easy, vibe-coded MCP for hetzner",
  description: "Paste a read-only Hetzner Cloud token, get an MCP URL for Claude. No sign-up, nothing stored.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
