import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Overlay — any-site page agent",
  description: "Point an agent at any URL. Extract the schema, propose variants, apply them live.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
