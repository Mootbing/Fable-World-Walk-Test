import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "World Walk",
  description: "First-person explorer of the real world, streamed live from open geodata",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
