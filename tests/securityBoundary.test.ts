import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { buildContentSecurityPolicy } from "../src/lib/contentSecurityPolicy";

describe("deployment security boundary", () => {
  it("ships browser security headers without a duplicate static CSP", async () => {
    const rules = await nextConfig.headers?.();
    const headers = new Map(rules?.[0]?.headers.map((header) => [header.key, header.value]));
    expect(headers.has("Content-Security-Policy")).toBe(false);
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
  });

  it("allows only explicit local and Codespaces development origins", () => {
    expect(nextConfig.allowedDevOrigins).toEqual(
      expect.arrayContaining(["127.0.0.1", "*.app.github.dev"]),
    );
  });

  it("authorizes framework scripts with a per-request nonce", () => {
    const policy = buildContentSecurityPolicy({ nonce: "test-nonce" });
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("'nonce-test-nonce'");
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(policy).not.toContain("'unsafe-inline' 'unsafe-eval'");
  });

  it("allows development diagnostics without weakening production scripts", () => {
    expect(buildContentSecurityPolicy({ nonce: "dev", development: true })).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy({ nonce: "prod" })).not.toContain("'unsafe-eval'");
  });

  it("does not emit a blocking CSP meta tag", async () => {
    const layout = await readFile("src/app/layout.tsx", "utf8");
    expect(layout).not.toContain('httpEquiv="Content-Security-Policy"');
  });

  it("packages OCR code, engine, and language data on the app origin", async () => {
    await expect(access("public/tesseract/worker.min.js")).resolves.toBeUndefined();
    await expect(access("public/tesseract-core/tesseract-core-lstm.wasm.js")).resolves.toBeUndefined();
    await expect(access("public/tessdata/eng.traineddata.gz")).resolves.toBeUndefined();
  });
});
