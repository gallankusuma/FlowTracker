import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowTracker — Uncover The Hidden Moves",
  description: "Platform smart money flow & bandarmology untuk saham IDX Indonesia. Lacak akumulasi, distribusi, insider moves, dan aktivitas broker secara real-time.",
  keywords: "bandarmology, IDX, saham Indonesia, flow analyzer, insider moves, accumulation streak",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body style={{ fontFamily: "'Inter', sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
