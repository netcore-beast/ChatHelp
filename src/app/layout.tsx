import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const staticContentSecurityPolicy = "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co https://raw.githubusercontent.com; manifest-src 'self'; upgrade-insecure-requests";

export const metadata: Metadata = {
  title: "ChatHelp — Private, on-device conversation copilot",
  description: "Generate thoughtful professional messages with an on-device language model, reviewed context, and no AI API.",
  applicationName: "ChatHelp",
  appleWebApp: { capable: true, title: "ChatHelp", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={geistSans.variable + " " + geistMono.variable}><head><meta httpEquiv="Content-Security-Policy" content={staticContentSecurityPolicy} /><meta name="referrer" content="no-referrer" /></head><body>{children}</body></html>;
}
