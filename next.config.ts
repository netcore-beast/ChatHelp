import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), display-capture=(self), payment=(), usb=()" },
];

const nativeBuild = process.env.CHATHELP_NATIVE_BUILD === "1";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.app.github.dev", "*.github.dev"],
  ...(nativeBuild ? {
    output: "export" as const,
    trailingSlash: true,
    images: { unoptimized: true },
  } : {
    async headers() {
      return [{ source: "/(.*)", headers: securityHeaders }];
    },
  }),
};

export default nextConfig;
