import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createCloudSafeWorkspace,
  createRecoveryBundle,
  decryptCloudWorkspace,
  encryptCloudWorkspace,
  importRecoveryKey,
  parseRecoveryBundle,
  serializeRecoveryBundle,
  summarizeCloudBackup,
} from "../src/lib/cloudRecovery";
import { openCloudRecoveryKey, removeCloudRecoveryKey, resetVaultForTests, saveCloudRecoveryKey } from "../src/lib/secureVault";
import { createEmptyWorkspace } from "../src/lib/workspaceTypes";

describe("DialogMint encrypted cloud recovery", () => {
  beforeEach(async () => { await resetVaultForTests(); });

  it("creates distinct browser-only recovery bundles without exposing their values", async () => {
    const first = await createRecoveryBundle();
    const second = await createRecoveryBundle();

    expect(first.version).toBe(1);
    expect(first.encryptionKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.encryptionKey).not.toBe(first.encryptionKey);
    expect(parseRecoveryBundle(serializeRecoveryBundle(first))).toEqual(first);
    expect(parseRecoveryBundle(JSON.stringify({ ...first, extra: true }))).toBeNull();
    expect(parseRecoveryBundle("not-json")).toBeNull();
  });

  it("stores the imported recovery key as a non-extractable device CryptoKey", async () => {
    const bundle = await createRecoveryBundle();
    const key = await importRecoveryKey(bundle.encryptionKey);
    expect(key.extractable).toBe(false);

    await saveCloudRecoveryKey(key);
    expect((await openCloudRecoveryKey())?.extractable).toBe(false);
    await removeCloudRecoveryKey();
    expect(await openCloudRecoveryKey()).toBeNull();
  });

  it("encrypts private workspace fields and rejects the wrong recovery key", async () => {
    const workspace = createEmptyWorkspace();
    workspace.cloudInference.consentedAt = "2026-08-05T00:00:00.000Z";
    workspace.guidance.playbooks["Network Marketing"].boundaries = "UNIQUE-PRIVATE-RULE";
    workspace.contacts = [{
      id: "private-contact", name: "UNIQUE-PRIVATE-NAME", headline: "Private headline", profileNotes: "Private notes",
      platform: "linkedin", platformUrl: "https://www.linkedin.com/in/unique-private", profileUrl: "https://www.linkedin.com/in/unique-private",
      chat: [{ id: "private-message", role: "them", body: "UNIQUE-PRIVATE-MESSAGE", createdAt: "2026-08-04T00:00:00.000Z" }],
      documents: [], outcomes: [], retentionDays: 90,
    }];
    const safe = createCloudSafeWorkspace(workspace, "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    const key = await importRecoveryKey((await createRecoveryBundle()).encryptionKey);
    const envelope = await encryptCloudWorkspace(safe, key, "testing", "2026-08-05T00:00:00.000Z");
    const serialized = JSON.stringify(envelope);

    for (const value of ["UNIQUE-PRIVATE-NAME", "UNIQUE-PRIVATE-MESSAGE", "unique-private", "UNIQUE-PRIVATE-RULE"]) {
      expect(serialized).not.toContain(value);
    }
    expect(await decryptCloudWorkspace(envelope, key, "testing")).toEqual(safe);
    const wrongKey = await importRecoveryKey((await createRecoveryBundle()).encryptionKey);
    await expect(decryptCloudWorkspace(envelope, wrongKey, "testing")).rejects.toThrow("recovery file does not unlock");
    await expect(decryptCloudWorkspace(envelope, key, "production")).rejects.toThrow("recovery file does not unlock");
  });

  it("removes confirmation state and material older than 90 days from cloud snapshots", () => {
    const workspace = createEmptyWorkspace();
    workspace.cloudInference.consentedAt = "2026-08-05T00:00:00.000Z";
    workspace.cloudRecovery = { enabled: true, revision: 7, lastConfirmedDigest: "logical", lastConfirmedCiphertextDigest: "cipher", lastConfirmedContacts: 1, lastConfirmedMessages: 2, lastSyncedAt: "today" };
    workspace.contacts = [{
      id: "contact-1", name: "Contact", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
      chat: [
        { id: "old", role: "them", body: "old", createdAt: "2026-04-01T00:00:00.000Z" },
        { id: "new", role: "them", body: "new", createdAt: "2026-08-01T00:00:00.000Z" },
      ],
      documents: [{ id: "old-doc", name: "Old", text: "old", createdAt: "2026-04-01T00:00:00.000Z" }],
      outcomes: [], retentionDays: 0,
    }];

    const safe = createCloudSafeWorkspace(workspace, "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    expect(safe.cloudInference).toEqual({ consentedAt: "" });
    expect(safe.cloudRecovery).toEqual({ enabled: false, revision: 0, lastConfirmedDigest: "", lastConfirmedCiphertextDigest: "", lastConfirmedContacts: 0, lastConfirmedMessages: 0, lastSyncedAt: "" });
    expect(safe.contacts[0].chat.map((message) => message.id)).toEqual(["new"]);
    expect(safe.contacts[0].documents).toEqual([]);
  });

  it("summarizes exact logical and encrypted snapshots without returning private contents", async () => {
    const workspace = createEmptyWorkspace();
    workspace.contacts = [{ id: "c", name: "Contact", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "", chat: [{ id: "m", role: "them", body: "Hello", createdAt: "2026-08-05T00:00:00.000Z" }], documents: [], outcomes: [], retentionDays: 90 }];
    const safe = createCloudSafeWorkspace(workspace, "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    const key = await importRecoveryKey((await createRecoveryBundle()).encryptionKey);
    const envelope = await encryptCloudWorkspace(safe, key, "testing", "2026-08-05T00:00:00.000Z");
    const summary = await summarizeCloudBackup(safe, envelope);

    expect(summary.contactCount).toBe(1);
    expect(summary.messageCount).toBe(1);
    expect(summary.logicalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(summary.ciphertextDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("Hello");
  });
});
