import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatHelp — Private cloud conversation copilot",
  description: "Organize selected LinkedIn conversations locally and generate reviewed replies with Cloudflare Workers AI.",
  applicationName: "ChatHelp",
  appleWebApp: { capable: true, title: "ChatHelp", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
