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

  it("tolerates browser extensions changing root attributes before hydration", async () => {
    const layout = await readFile("src/app/layout.tsx", "utf8");
    expect(layout).toMatch(/<html[\s\S]*suppressHydrationWarning/);
    expect(layout).toContain("<body suppressHydrationWarning>");
  });

  it("packages OCR code, engine, and language data on the app origin", async () => {
    await expect(access("public/tesseract/worker.min.js")).resolves.toBeUndefined();
    await expect(access("public/tesseract-core/tesseract-core-lstm.wasm.js")).resolves.toBeUndefined();
    await expect(access("public/tessdata/eng.traineddata.gz")).resolves.toBeUndefined();
  });

  it("has no runtime migration route or secret-bearing release command", async () => {
    const [workerSource, releaseDoc] = await Promise.all([
      readFile("cloudflare/worker/src/index.js", "utf8"),
      readFile("docs/cloud-learning-usage-release.md", "utf8"),
    ]);

    expect(workerSource).not.toMatch(/\/api\/(?:migrate|admin\/schema)/u);
    expect(releaseDoc).not.toMatch(/(?:postgres(?:ql)?:\/\/|ANTHROPIC_API_KEY\s*=|CF_API_TOKEN\s*=|DATABASE_URL\s*=)/u);
  });

  it("states retrieval and future-training boundaries accurately", async () => {
    const releaseDoc = await readFile("docs/cloud-learning-usage-release.md", "utf8");

    expect(releaseDoc).toContain("Saving a Neon record does not train a model.");
    expect(releaseDoc).toContain("@cf/meta/llama-3.1-8b-instruct-fast");
    expect(releaseDoc).toContain("@cf/openai/gpt-oss-120b");
    expect(releaseDoc).toContain("not currently listed as LoRA-capable targets");
    expect(releaseDoc).toMatch(/not currently listed as LoRA-capable targets\.\s+Model support can change/iu);
  });

  it("keeps privacy and security notices aligned with server-readable storage boundaries", async () => {
    const notices = await Promise.all([
      readFile("PRIVACY.md", "utf8"),
      readFile("SECURITY.md", "utf8"),
    ]);

    for (const notice of notices) {
      expect(notice).toContain("Anthropic");
      expect(notice).toContain("@cf/meta/llama-3.1-8b-instruct-fast");
      expect(notice).toContain("@cf/openai/gpt-oss-120b");
      expect(notice).toContain("Approved learning records are server-readable, de-identified, purpose-limited, and retained for 365 days.");
      expect(notice).toContain("The numeric/model-only usage ledger contains no conversation or draft text.");
      expect(notice).toContain("Usage attempts are retained for 365 days.");
      expect(notice).toContain("Encrypted recovery snapshots are retained for at most 90 days.");
      expect(notice).toContain("Usage is a server-authoritative, per-signed-in-account ChatHelp app allowance estimate. It is not provider credit, a billing balance, a prepaid balance, or a provider account balance.");
      expect(notice).toContain("Saving a Neon record does not train a model.");
      expect(notice).toContain("Learning, usage, recovery, and the local workspace have separate deletion controls; deleting one does not silently delete the others.");
      expect(notice).not.toMatch(/storage-free|local-only workspace|Workers AI only|does not provide cross-device recovery|no export or recovery/iu);
      expect(notice).not.toMatch(/(?:is|are|represents?|equals?)\s+(?!not\b)(?:an?\s+)?provider (?:credits?|billing balance|prepaid balance|account balance)/iu);
      expect(notice).not.toMatch(/(?:learning|training)\s+(?:stores|includes|uploads|uses)\s+(?:raw\s+)?(?:provider|generated)\s+(?:output|draft|reply|reasoning)/iu);
    }
  });

  it("documents direct text-free decisions and atomic authored replacement", async () => {
    const notices = await Promise.all([
      readFile("PRIVACY.md", "utf8"),
      readFile("SECURITY.md", "utf8"),
      readFile("docs/cloud-learning-usage-release.md", "utf8"),
    ]);

    for (const notice of notices) {
      expect(notice).toMatch(/Copy.*Useful.*Not useful/is);
      expect(notice).toMatch(/one.*record|same.*row/is);
      expect(notice).toMatch(/independently authored.*sanitized/is);
      expect(notice).not.toMatch(/Save improvement uploads/i);
    }
  });

  it("limits the no-store disclosure to protected APIs and health", async () => {
    const securityNotice = await readFile("SECURITY.md", "utf8");

    expect(securityNotice).toContain("Every protected API response and the `/health` response uses `Cache-Control: no-store`.");
    expect(securityNotice).not.toContain("Every authenticated application response uses `Cache-Control: no-store`.");
  });
});
