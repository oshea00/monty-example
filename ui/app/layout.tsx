import type { Metadata } from "next";
import "./globals.css";
import { Roboto_Mono } from "next/font/google";

const robotoMono = Roboto_Mono({ subsets: ["latin"], variable: "--font-roboto-mono" });

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
    <html lang="en" className={robotoMono.variable}>
      <body>{children}</body>
    </html>
  );
}
