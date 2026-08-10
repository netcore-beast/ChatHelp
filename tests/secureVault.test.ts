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

  it("migrates old browser models to cloud consent without retaining a separate access code", () => {
    const workspace = normalizeWorkspace({
      modelId: "retired-browser-model",
      cloudInference: { accessToken: "SYNTHETIC-RETIRED-CODE", consentedAt: "2026-08-01T00:00:00.000Z", rememberAccessToken: true },
    });

    expect(workspace.modelId).toBe(CLOUDFLARE_MODEL_ID);
    expect(workspace.cloudInference).toEqual({ consentedAt: "2026-08-01T00:00:00.000Z" });
    expect(workspace).not.toHaveProperty("cloudInference.accessToken");
    expect(workspace).not.toHaveProperty("cloudInference.rememberAccessToken");
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

    expect(workspace.version).toBe(14);
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

  it("migrates retired R2 confirmation fields to disabled Neon recovery state", () => {
    const workspace = normalizeWorkspace({
      version: 9,
      contacts: [],
      cloudRecovery: {
        enabled: true,
        locatorHash: "retired-locator",
        etag: "retired-etag",
        lastConfirmedDigest: "logical-digest",
        lastConfirmedContacts: 4.8,
        lastConfirmedMessages: -3,
        lastSyncedAt: "2026-08-01T00:00:00.000Z",
      },
    });

    expect(workspace.cloudRecovery).toEqual({
      enabled: true,
      revision: 0,
      lastConfirmedDigest: "logical-digest",
      lastConfirmedCiphertextDigest: "",
      lastConfirmedContacts: 4,
      lastConfirmedMessages: 0,
      lastSyncedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(workspace).not.toHaveProperty("cloudRecovery.locatorHash");
    expect(workspace).not.toHaveProperty("cloudRecovery.etag");
    expect(workspace.deletionTombstones).toEqual([]);
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

  it("migrates stage-aware guidance safely and round-trips it only inside ciphertext", async () => {
    const migrated = normalizeWorkspace({
      version: 10,
      personalGuidelines: "  Prefer one thoughtful question.  ",
      contacts: [{
        id: "alex",
        name: "Alex",
        relationshipStage: "not-a-stage",
        conversationGoal: "Learn what kind of support would be useful.",
      }],
    });

    expect(migrated.version).toBe(14);
    expect(migrated.personalGuidelines).toBe("Prefer one thoughtful question.");
    expect(migrated.contacts[0]).toMatchObject({
      relationshipStage: "new_connection",
      conversationGoal: "Learn what kind of support would be useful.",
    });

    migrated.contacts[0].relationshipStage = "learn_interests";
    await createDeviceVault(migrated);

    const stored = JSON.stringify(await readVaultEnvelopeForTests());
    expect(stored).not.toContain("Prefer one thoughtful question.");
    expect(stored).not.toContain("learn_interests");

    const reopened = (await openDeviceVault()).workspace;
    expect(reopened.personalGuidelines).toBe("Prefer one thoughtful question.");
    expect(reopened.contacts[0].relationshipStage).toBe("learn_interests");
    expect(reopened.contacts[0].conversationGoal).toBe("Learn what kind of support would be useful.");
  });

  it("migrates learning disabled and keeps approved examples only inside encrypted vault data", async () => {
    const legacy = normalizeWorkspace({
      version: 11,
      feedback: [{
        id: "legacy-feedback",
        contactId: "alex",
        draft: "Legacy provider response",
        rating: "useful",
        note: "Helpful",
        createdAt: "2026-08-01T00:00:00.000Z",
      }],
    });
    expect(legacy.personalLearning).toEqual({ enabled: true });
    expect(legacy.feedback[0]).toMatchObject({ action: "accepted", origin: "provider_assisted", eligibleForRetrieval: false });

    legacy.personalLearning.enabled = true;
    legacy.feedback[0] = {
      ...legacy.feedback[0],
      origin: "independently_user_authored",
      independentlyAuthoredAttested: true,
      preferredResponse: "What would make this opportunity useful to you?",
      eligibleForRetrieval: true,
    };
    await createDeviceVault(legacy);

    const stored = JSON.stringify(await readVaultEnvelopeForTests());
    expect(stored).not.toContain("What would make this opportunity useful to you?");
    const reopened = (await openDeviceVault()).workspace;
    expect(reopened.personalLearning.enabled).toBe(true);
    expect(reopened.feedback[0]).toMatchObject({ eligibleForRetrieval: true, preferredResponse: "What would make this opportunity useful to you?" });
  });

  it("migrates version 13 learning to bounded default-on version 14 metadata without copying feedback", () => {
    const migrated = normalizeWorkspace({
      version: 13,
      aiUsage: [{
        id: "legacy-usage", contactId: "alex", modelId: "legacy-model", promptCharacters: 42,
        variants: 3, estimatedCostUsd: 9.99, createdAt: "2026-08-01T00:00:00.000Z",
      }],
      feedback: [{
        id: "legacy-feedback", contactId: "alex", draft: "Provider draft", preferredResponse: "A private reply",
        action: "accepted", origin: "independently_user_authored", independentlyAuthoredAttested: true,
        eligibleForRetrieval: true, createdAt: "2026-08-01T00:00:00.000Z",
      }],
      stageTrainingRecords: [{
        id: "eligible-stage", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "medium",
        hasIncomingQuestion: true, hasNeedSignal: false, hasPermissionSignal: true, hasValueDiscussionSignal: false,
        hasNextStepSignal: false, semanticTokens: ["confidential-token"], confirmedStage: "ask_permission",
        humanConfirmed: true, createdAt: "2026-08-01T00:00:00.000Z",
      }, {
        id: "provider-assisted-stage", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low",
        hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false,
        hasNextStepSignal: false, semanticTokens: ["must-not-copy"], confirmedStage: "new_connection",
        humanConfirmed: false, createdAt: "2026-08-01T00:00:00.000Z",
      }],
    });

    expect(migrated.version).toBe(14);
    expect(migrated.aiUsage).toEqual([{
      id: "legacy-usage", contactId: "alex", modelId: "legacy-model", promptCharacters: 42,
      variants: 3, estimatedCostUsd: 0, createdAt: "2026-08-01T00:00:00.000Z",
    }]);
    expect(migrated.personalLearning.enabled).toBe(true);
    expect(migrated.cloudLearningSync).toEqual([]);
    expect(migrated.feedback).toHaveLength(1);
    expect(migrated.stageTrainingRecords.map((record) => record.id)).toEqual(["eligible-stage", "provider-assisted-stage"]);
    expect(migrated.pendingLearningRecords.map((row) => row.recordKind)).toEqual(["classifier"]);
    const serialized = JSON.stringify(migrated.pendingLearningRecords);
    expect(serialized).not.toContain("semanticTokens");
    expect(serialized).not.toContain("confidential-token");
    expect(serialized).not.toContain("conversationGoal");
    expect(serialized).not.toContain("provider_assisted");
  });

  it("bounds persisted pending, sync, and deletion metadata while retaining the newest valid records", () => {
    const entry = (index: number) => ({
      recordId: `record-${index}`,
      recordKind: "classifier" as const,
      sanitizedPayload: {
        recordKind: "classifier", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", provenance: "human_confirmed",
        classifierFeatures: { messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false },
      },
      sourceCollection: "stageTrainingRecords" as const,
      sourceLocalId: `source-${index}`,
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2027-08-01T00:00:00.000Z",
    });
    const pending = Array.from({ length: 1_001 }, (_, index) => entry(index));
    const sync = pending.map((record) => ({ recordId: record.recordId, contentDigest: "a".repeat(63) + (record.recordId.endsWith("0") ? "0" : "1"), status: "pending" as const, updatedAt: record.createdAt }));
    const markers = pending.map((record) => ({ recordId: record.recordId, disposition: "acknowledged", sourceCollection: "stageTrainingRecords", sourceLocalId: record.sourceLocalId, deletedAt: record.createdAt }));
    const migrated = normalizeWorkspace({ version: 14, pendingLearningRecords: pending, cloudLearningSync: sync, cloudLearningDeletionMarkers: markers, cloudLearningClearedAt: "2026-08-01T00:00:00.000Z" });

    expect(migrated.pendingLearningRecords).toHaveLength(1_000);
    expect(migrated.pendingLearningRecords[0].recordId).toBe("record-1");
    expect(migrated.cloudLearningSync).toHaveLength(1_000);
    expect(migrated.cloudLearningSync[0].recordId).toBe("record-1");
    expect(migrated.cloudLearningDeletionMarkers).toHaveLength(1_000);
    expect(migrated.cloudLearningDeletionMarkers[0].recordId).toBe("record-1");
    expect(migrated.cloudLearningClearedAt).toBe("2026-08-01T00:00:00.000Z");
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
