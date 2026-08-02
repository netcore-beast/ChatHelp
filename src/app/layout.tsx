import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ChatHelp — Private cloud conversation copilot",
  description: "Generate reviewed professional replies with Cloudflare Workers AI and user-selected local screen capture.",
  applicationName: "ChatHelp",
  appleWebApp: { capable: true, title: "ChatHelp", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={geistSans.variable + " " + geistMono.variable}
      suppressHydrationWarning
    >
      <head>
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
