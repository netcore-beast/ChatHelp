import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("DialogMint customer-facing branding", () => {
  it("brands the web app, PWA, desktop package, and extension as DialogMint", () => {
    expect(read("src/app/layout.tsx")).toContain('title: "DialogMint — Private cloud conversation copilot"');
    expect(read("src/components/ChatHelpApp.tsx")).toContain('<p className="eyebrow">DIALOGMINT</p>');
    expect(read("public/manifest.webmanifest")).toContain('"name": "DialogMint Private Conversation Studio"');
    expect(read("public/offline.html")).toContain("DialogMint is offline");
    expect(read("electron-builder.yml")).toContain("productName: DialogMint");

    const manifest = JSON.parse(read("extension/manifest.json"));
    expect(manifest.name).toBe("DialogMint LinkedIn Conversation Reader");
    expect(manifest.version).toBe("0.5.1");
    expect(manifest.description).toContain("DialogMint");
    expect(read("extension/README.md")).toContain("# DialogMint LinkedIn Conversation Reader");
    expect(read("extension/background.js")).toContain("Open DialogMint to receive synchronized conversations.");
  });

  it("preserves deployed origins and compatibility identifiers during the rename", () => {
    const manifest = read("extension/manifest.json");
    const background = read("extension/background.js");
    expect(manifest).toContain("https://chathelp-private-cloud.project-mission-ai.workers.dev/*");
    expect(manifest).toContain("https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/*");
    expect(background).toContain('const SYNC_SCRIPT_ID = "chathelp-linkedin-auto-sync-v1"');
    expect(read("extension/app-bridge.js")).toContain('const SOURCE = "chathelp-linkedin-extension"');
    expect(read("src/lib/linkedinExtension.ts")).toContain('export const LINKEDIN_EXTENSION_SOURCE = "chathelp-linkedin-extension"');
    expect(read("src/lib/secureVault.ts")).toContain('const DB_NAME = "chathelp-secure"');
    expect(read("desktop/main.cjs")).toContain('scheme: "chathelp"');
  });
});
