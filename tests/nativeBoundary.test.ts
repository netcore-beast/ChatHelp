import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { injectCspIntoHtml } from "../scripts/inject-static-csp.mjs";

const read = (path: string) => readFileSync(path, "utf8");

describe("installable client boundaries", () => {
  it("keeps the Electron renderer sandboxed and denies arbitrary windows", () => {
    const main = read("desktop/main.cjs");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("webviewTag: false");
    expect(main).toContain('return { action: "deny" }');
    expect(main).toContain("request.userGesture");
    expect(main).toContain("dialog.showMessageBox");
  });

  it("disables Android backup and cleartext transport", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(manifest).toContain('android:fullBackupContent="false"');
  });

  it("caches only the public application shell and static assets", () => {
    const worker = read("public/sw.js");
    expect(worker).toContain('url.origin !== self.location.origin');
    expect(worker).toContain('request.method !== "GET"');
    expect(worker).not.toContain("indexedDB");
    expect(worker).not.toContain("localStorage");
  });

  it("routes static assets through the selected Worker version before serving them", () => {
    const config = JSON.parse(read("wrangler.jsonc"));
    expect(config.assets.run_worker_first).toBe(true);
  });

  it("isolates each Worker environment to its own database while preserving shared runtime bindings", () => {
    const wrangler = read("wrangler.jsonc");
    const config = JSON.parse(wrangler);
    const requiredSecrets = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD_TESTING", "ACCESS_AUD_PRODUCTION", "ANTHROPIC_API_KEY"];

    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"crons": ["0 3 * * *"]');
    expect(config.name).toBe("chathelp-private-cloud-unconfigured");
    expect(config.name).not.toBe(config.env.testing.name);
    expect(config.name).not.toBe(config.env.production.name);
    expect(config.hyperdrive).toBeUndefined();
    expect(config.env.testing).toMatchObject({
      name: "testing-chathelp-private-cloud",
      vars: { DEPLOYMENT_ENVIRONMENT: "testing" },
      ai: { binding: "AI" },
      secrets: { required: requiredSecrets },
      hyperdrive: [{ binding: "NEON_TESTING", id: "69eb149ad82d40cba7e729279294d521" }],
    });
    expect(config.env.production).toMatchObject({
      name: "chathelp-private-cloud",
      vars: { DEPLOYMENT_ENVIRONMENT: "production" },
      ai: { binding: "AI" },
      secrets: { required: requiredSecrets },
      hyperdrive: [{ binding: "NEON_PRODUCTION", id: "0df56a4e086547eb9e15d1d964556676" }],
    });
    expect(config.env.testing.ratelimits).toEqual(config.env.production.ratelimits);
    expect(config.env.testing.hyperdrive.some(({ binding }: { binding: string }) => binding === "NEON_PRODUCTION")).toBe(false);
    expect(config.env.production.hyperdrive.some(({ binding }: { binding: string }) => binding === "NEON_TESTING")).toBe(false);
    expect(wrangler).not.toContain("CHATHELP_ACCESS_TOKEN_HASH");
    expect(wrangler).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(wrangler).not.toMatch(/connectionString/i);
  });

  it("pins Cloudflare verification and release scripts to explicit environments", () => {
    const scripts = JSON.parse(read("package.json")).scripts;

    expect(scripts["verify:cloudflare"]).toContain("--env testing");
    expect(scripts["verify:cloudflare:production"]).toContain("--env production");
    expect(scripts["deploy:cloudflare:testing"]).toContain("deploy --env testing");
    expect(scripts["deploy:cloudflare:testing"]).toContain("--keep-vars");
    expect(scripts["deploy:cloudflare"]).toContain("--env production");
  });

  it("keeps generated Wrangler bundles out of source control and lint inputs", () => {
    expect(read(".gitignore")).toContain("/.wrangler-*/");
    expect(read("eslint.config.mjs")).toContain('".wrangler-*/**"');
  });

  it("hash-authorizes static bootstrap scripts without unsafe-inline", () => {
    const source = "self.__next_f.push(['test'])";
    const hash = createHash("sha256").update(source, "utf8").digest("base64");
    const html = injectCspIntoHtml(`<html><head></head><body><script>${source}</script><script src="/_next/app.js"></script></body></html>`);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain(`'sha256-${hash}'`);
    expect(html).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(html).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
