import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("deployment security boundary", () => {
  it("ships restrictive browser security headers", async () => {
    const rules = await nextConfig.headers?.();
    const headers = new Map(rules?.[0]?.headers.map((header) => [header.key, header.value]));
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("object-src 'none'");
    expect(headers.get("Content-Security-Policy")).not.toContain("script-src 'self' 'unsafe-eval'");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
  });

  it("packages OCR code, engine, and language data on the app origin", async () => {
    await expect(access("public/tesseract/worker.min.js")).resolves.toBeUndefined();
    await expect(access("public/tesseract-core/tesseract-core-lstm.wasm.js")).resolves.toBeUndefined();
    await expect(access("public/tessdata/eng.traineddata.gz")).resolves.toBeUndefined();
  });
});
