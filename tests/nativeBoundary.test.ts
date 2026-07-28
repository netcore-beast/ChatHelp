import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});
