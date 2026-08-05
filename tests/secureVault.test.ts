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

  it("migrates one legacy playbook into the closest role without overwriting other role defaults", () => {
    const workspace = normalizeWorkspace({
      guidance: {
        role: "Recruiting team",
        objective: "LEGACY-HR-GOAL",
        voice: "Clear and considerate",
        boundaries: "LEGACY-HR-RULES",
      },
    });

    expect(workspace.version).toBe(8);
    expect(workspace.guidance.selectedRole).toBe("Human Resource");
    expect(workspace.inboxRole).toBe("Human Resource");
    expect(workspace.guidance.playbooks["Human Resource"]).toEqual({
      objective: "LEGACY-HR-GOAL",
      boundaries: "LEGACY-HR-RULES",
      rulebookDigest: "- LEGACY-HR-RULES",
    });
    expect(workspace.guidance.playbooks["Network Marketing"].objective).not.toBe("LEGACY-HR-GOAL");
    expect(workspace.guidance.voice).toBe("Clear and considerate");
  });

  it("preserves separately edited role playbooks and the Inbox role after reopening", async () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.playbooks["Human Resource"] = { objective: "HR-ONLY-GOAL", boundaries: "HR-ONLY-RULES", rulebookDigest: "- HR-ONLY-RULES" };
    workspace.guidance.playbooks["Network Marketing"] = { objective: "NETWORK-ONLY-GOAL", boundaries: "NETWORK-ONLY-RULES", rulebookDigest: "- NETWORK-ONLY-RULES" };
    workspace.guidance.selectedRole = "Human Resource";
    workspace.inboxRole = "Network Marketing";
    await createDeviceVault(workspace);

    const reopened = (await openDeviceVault()).workspace;
    expect(reopened.guidance.playbooks["Human Resource"]).toEqual({ objective: "HR-ONLY-GOAL", boundaries: "HR-ONLY-RULES", rulebookDigest: "- HR-ONLY-RULES" });
    expect(reopened.guidance.playbooks["Network Marketing"]).toEqual({ objective: "NETWORK-ONLY-GOAL", boundaries: "NETWORK-ONLY-RULES", rulebookDigest: "- NETWORK-ONLY-RULES" });
    expect(reopened.guidance.selectedRole).toBe("Human Resource");
    expect(reopened.inboxRole).toBe("Network Marketing");
  });

  it("encrypts and restores reply rules beyond the former 20,000-character limit", async () => {
    const workspace = createEmptyWorkspace();
    const tailMarker = "FINAL-PERSISTED-RULE";
    workspace.guidance.playbooks["Human Resource"].boundaries = "Detailed rule. ".repeat(2_000) + tailMarker;
    await createDeviceVault(workspace);

    const reopened = (await openDeviceVault()).workspace;
    expect(reopened.guidance.playbooks["Human Resource"].boundaries).toContain(tailMarker);
    expect(reopened.guidance.playbooks["Human Resource"].boundaries.length).toBeGreaterThan(20_000);
  });

  it("repairs legacy LinkedIn capture duplicates while normalizing the encrypted vault", () => {
    const workspace = normalizeWorkspace({
      contacts: [{
        id: "amit",
        name: "Amit Dabral",
        platform: "linkedin",
        chat: [
          { id: "linkedin-old1", role: "them", speaker: "Amit Dabral", body: "That would be great", createdAt: "2026-08-02T11:55:00.000Z" },
          { id: "linkedin-old2", role: "them", speaker: "Amit Dabral", body: "That would be great", createdAt: "2026-08-02T11:57:00.000Z" },
        ],
      }],
    });

    expect(workspace.contacts[0].chat).toHaveLength(1);
    expect(workspace.contacts[0].chat[0].body).toBe("That would be great");
  });

  it("normalizes and encrypts local pin, read-later, and safe sync diagnostics", async () => {
    const legacy = normalizeWorkspace({
      contacts: [{ id: "legacy", name: "Legacy", platform: "linkedin", chat: [] }],
    });
    expect(legacy.contacts[0].pinned).toBe(false);
    expect(legacy.contacts[0].readLater).toBe(false);
    expect(legacy.contacts[0].lastSyncDiagnostic).toBeUndefined();

    const workspace = createEmptyWorkspace();
    workspace.contacts = [{
      id: "taylor",
      name: "Taylor Lee",
      headline: "Talent Partner",
      profileNotes: "",
      platform: "linkedin",
      platformUrl: "",
      chat: [],
      documents: [],
      outcomes: [],
      retentionDays: 90,
      pinned: true,
      readLater: true,
      lastSyncDiagnostic: {
        action: "updated",
        visibleMessages: 8,
        importedMessages: 2,
        duplicateMessages: 6,
        restoredFromArchive: false,
        snapshotFingerprint: "abc123",
        synchronizedAt: "2026-08-05T12:00:00.000Z",
      },
    }];
    await createDeviceVault(workspace);

    const reopened = (await openDeviceVault()).workspace.contacts[0];
    expect(reopened.pinned).toBe(true);
    expect(reopened.readLater).toBe(true);
    expect(reopened.lastSyncDiagnostic).toEqual(workspace.contacts[0].lastSyncDiagnostic);
    const stored = JSON.stringify(await readVaultEnvelopeForTests());
    expect(stored).not.toContain("abc123");
  });

  it("stores no readable workspace content and opens without a passphrase", async () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.playbooks[workspace.guidance.selectedRole].objective = "CONFIDENTIAL-ACQUISITION-PLAN";
    const created = await createDeviceVault(workspace);
    const stored = JSON.stringify(await readVaultEnvelopeForTests());
    expect(stored).not.toContain("CONFIDENTIAL-ACQUISITION-PLAN");
    expect(created.session.key.extractable).toBe(false);

    const reopened = await openDeviceVault();
    expect(reopened.workspace.guidance.playbooks[reopened.workspace.guidance.selectedRole].objective).toBe("CONFIDENTIAL-ACQUISITION-PLAN");
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
    workspace.guidance.playbooks[workspace.guidance.selectedRole].objective = "Keep this history";
    await createLegacyVaultForTests("correct horse battery staple", workspace);
    expect(await getVaultMode()).toBe("legacy-passphrase");
    await expect(migrateLegacyVault("this passphrase is wrong")).rejects.toThrow(/Incorrect passphrase/);

    await migrateLegacyVault("correct horse battery staple");
    expect(await getVaultMode()).toBe("device");
    const reopened = (await openDeviceVault()).workspace;
    expect(reopened.guidance.playbooks[reopened.guidance.selectedRole].objective).toBe("Keep this history");
  }, 15_000);
});
