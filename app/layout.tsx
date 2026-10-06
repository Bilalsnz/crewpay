import type { Metadata, Viewport } from "next";

import { BRAND, META_DESCRIPTION, META_TITLE } from "@/lib/brand";
import { Providers } from "./providers";
import "./globals.css";

/**
 * No title template on purpose. The contract version's screens still say
 * CrewPay in their own metadata, and they are untouched — a template would
 * append "| FlowPay" to them and produce a title that is wrong twice over.
 * Every FlowPay page spells its own full title instead.
 */
export const metadata: Metadata = {
  title: META_TITLE,
  description: META_DESCRIPTION,
  applicationName: BRAND,
  openGraph: {
    title: META_TITLE,
    description: META_DESCRIPTION,
    siteName: BRAND,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: META_TITLE,
    description: META_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#5b6cff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
