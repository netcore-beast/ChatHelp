import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ChatHelp — Private, on-device conversation copilot",
  description: "Generate thoughtful professional messages with an on-device language model, reviewed context, and no AI API.",
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
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
