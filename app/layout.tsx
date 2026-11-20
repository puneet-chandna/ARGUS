import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "./globals.css";

const instrument = localFont({
  src: "../node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
  variable: "--instrument-sans",
  weight: "400 700",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://argus.puneetchandna.com"),
  title: "Argus · Motor policy brokerage",
  description: "Review motor policy commission rates and the evidence behind each rate-card lookup.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#061014" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" className={instrument.variable}><body>{children}</body></html>;
}
