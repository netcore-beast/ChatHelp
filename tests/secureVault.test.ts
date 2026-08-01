import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createVault, exportEncryptedBackup, importEncryptedBackup, normalizeWorkspace, resetVaultForTests, saveVault, unlockVault } from "../src/lib/secureVault";
import { CLOUDFLARE_MODEL_ID, createEmptyWorkspace } from "../src/lib/workspaceTypes";

describe("encrypted vault", () => {
  beforeEach(async () => { await resetVaultForTests(); });

  it("migrates old browser models to cloud and discards access codes stored without explicit permission", () => {
    const workspace = normalizeWorkspace({
      modelId: "retired-browser-model",
      cloudInference: { accessToken: "placeholder-code", consentedAt: "2026-08-01T00:00:00.000Z" },
    });

    expect(workspace.modelId).toBe(CLOUDFLARE_MODEL_ID);
    expect(workspace.cloudInference).toEqual({
      accessToken: "",
      consentedAt: "2026-08-01T00:00:00.000Z",
      rememberAccessToken: false,
    });
  });

  it("stores no readable workspace content and unlocks with the passphrase", async () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.objective = "CONFIDENTIAL-ACQUISITION-PLAN";
    await createVault("correct horse battery staple", workspace);
    const backup = await exportEncryptedBackup();
    expect(backup).not.toContain("CONFIDENTIAL-ACQUISITION-PLAN");
    expect(backup).not.toContain("correct horse battery staple");
    const unlocked = await unlockVault("correct horse battery staple");
    expect(unlocked.workspace.guidance.objective).toBe("CONFIDENTIAL-ACQUISITION-PLAN");
    expect(unlocked.session.key.extractable).toBe(false);
  }, 20_000);

  it("rejects a wrong passphrase and tampered ciphertext", async () => {
    await createVault("correct horse battery staple", createEmptyWorkspace());
    await expect(unlockVault("this passphrase is wrong")).rejects.toThrow(/Incorrect passphrase/);
    const backup = JSON.parse(await exportEncryptedBackup());
    backup.cipher.ciphertext = backup.cipher.ciphertext.slice(0, -4) + "AAAA";
    await expect(importEncryptedBackup(JSON.stringify(backup), "correct horse battery staple")).rejects.toThrow(/changed/);
  }, 20_000);

  it("uses a fresh AES-GCM IV for every save", async () => {
    const created = await createVault("correct horse battery staple", createEmptyWorkspace());
    const first = JSON.parse(await exportEncryptedBackup());
    await saveVault(created.workspace, created.session);
    const second = JSON.parse(await exportEncryptedBackup());
    expect(second.cipher.iv).not.toBe(first.cipher.iv);
    expect(second.kdf.salt).toBe(first.kdf.salt);
  }, 20_000);
});
