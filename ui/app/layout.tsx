import type { Metadata } from "next";
import "./globals.css";

// CUSTOMIZE: browser tab title and SEO description.
export const metadata: Metadata = {
  title: "Monty Expense Analyst",
  description: "AI-powered expense analysis with step-by-step visualization",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
