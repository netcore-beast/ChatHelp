import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDeviceVault,
  createLegacyVaultForTests,
  getVaultMode,
  migrateLegacyVault,
  normalizeWorkspace,
  openDeviceVault,
  readVaultEnvelopeForTests,
  resetVaultForTests,
  saveVault,
  writeVaultEnvelopeForTests,
} from "../src/lib/secureVault";
import { CLOUDFLARE_MODEL_ID, createEmptyWorkspace } from "../src/lib/workspaceTypes";

describe("encrypted device vault", () => {
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

  it("stores no readable workspace content and opens without a passphrase", async () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.objective = "CONFIDENTIAL-ACQUISITION-PLAN";
    const created = await createDeviceVault(workspace);
    const stored = JSON.stringify(await readVaultEnvelopeForTests());
    expect(stored).not.toContain("CONFIDENTIAL-ACQUISITION-PLAN");
    expect(created.session.key.extractable).toBe(false);

    const reopened = await openDeviceVault();
    expect(reopened.workspace.guidance.objective).toBe("CONFIDENTIAL-ACQUISITION-PLAN");
    expect(reopened.session.key.extractable).toBe(false);
  });

  it("rejects tampered ciphertext", async () => {
    await createDeviceVault(createEmptyWorkspace());
    const envelope = await readVaultEnvelopeForTests() as { cipher: { ciphertext: string } };
    envelope.cipher.ciphertext = envelope.cipher.ciphertext.slice(0, -4) + "AAAA";
    await writeVaultEnvelopeForTests(envelope);
    await expect(openDeviceVault()).rejects.toThrow(/could not unlock/);
  });

  it("uses a fresh AES-GCM IV for every save", async () => {
    const created = await createDeviceVault(createEmptyWorkspace());
    const first = await readVaultEnvelopeForTests() as { cipher: { iv: string } };
    await saveVault(created.workspace, created.session);
    const second = await readVaultEnvelopeForTests() as { cipher: { iv: string } };
    expect(second.cipher.iv).not.toBe(first.cipher.iv);
  });

  it("converts a passphrase vault once and then opens with the device key", async () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.objective = "Keep this history";
    await createLegacyVaultForTests("correct horse battery staple", workspace);
    expect(await getVaultMode()).toBe("legacy-passphrase");
    await expect(migrateLegacyVault("this passphrase is wrong")).rejects.toThrow(/Incorrect passphrase/);

    await migrateLegacyVault("correct horse battery staple");
    expect(await getVaultMode()).toBe("device");
    expect((await openDeviceVault()).workspace.guidance.objective).toBe("Keep this history");
  });
});
