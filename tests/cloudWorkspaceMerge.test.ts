import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDeletedCloudLearningSyncMetadata, clearDisabledCloudLearningState, syncPendingLearningRecords } from "../src/lib/cloudLearning";
import { deleteContactEverywhere, mergeCloudWorkspaces } from "../src/lib/cloudWorkspaceMerge";
import { createEmptyWorkspace, type Contact, type WorkspaceData } from "../src/lib/workspaceTypes";

function contact(overrides: Partial<Contact>): Contact {
  return {
    id: "contact-default", name: "Alex", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
    chat: [], documents: [], outcomes: [], retentionDays: 90, labels: [], pipelineStage: "inbox", notes: "", draftHistory: [],
    ...overrides,
  };
}

function workspace(contacts: Contact[]): WorkspaceData {
  return { ...createEmptyWorkspace(), contacts };
}

describe("encrypted workspace merge", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("does not merge same-name contacts when their normalized profile URLs differ", async () => {
    const local = workspace([contact({ id: "local", name: "Alex Smith", profileUrl: "https://linkedin.com/in/alex-one" })]);
    const remote = workspace([contact({ id: "remote", name: "Alex Smith", profileUrl: "https://www.linkedin.com/in/alex-two/" })]);

    expect((await mergeCloudWorkspaces(local, remote)).contacts.map((item) => item.id)).toEqual(["local", "remote"]);
  });

  it("matches by profile before name and deduplicates stable IDs and fallback fingerprints", async () => {
    const local = workspace([contact({
      id: "local", name: "Old Display", profileUrl: "https://linkedin.com/in/same-person", labels: ["Local"], notes: "Keep local note",
      chat: [
        { id: "stable", role: "them", speaker: "Same Person", body: "Hello", createdAt: "2026-08-01T00:00:00.000Z" },
        { id: "local-fallback", role: "me", speaker: "You", body: "How are you?", createdAt: "2026-08-02T00:00:00.000Z" },
      ],
    })]);
    const remote = workspace([contact({
      id: "remote", name: "Current Display", profileUrl: "https://www.linkedin.com/in/same-person/", labels: ["Remote"], notes: "",
      chat: [
        { id: "stable", role: "them", speaker: "Same Person", body: "Hello", createdAt: "2026-08-01T00:00:00.000Z" },
        { id: "remote-fallback", role: "me", speaker: "You", body: "  How are you? ", createdAt: "2026-08-02T00:00:00.000Z" },
        { id: "new", role: "them", speaker: "Same Person", body: "Doing well", createdAt: "2026-08-03T00:00:00.000Z" },
      ],
    })]);

    const merged = await mergeCloudWorkspaces(local, remote);
    expect(merged.contacts).toHaveLength(1);
    expect(merged.contacts[0].chat.map((message) => message.id)).toEqual(["stable", "local-fallback", "new"]);
    expect(merged.contacts[0].labels).toEqual(["Local", "Remote"]);
    expect(merged.contacts[0].notes).toBe("Keep local note");
  });

  it("keeps ambiguous normalized-name contacts separate", async () => {
    const local = workspace([
      contact({ id: "local-1", name: "Taylor Lee" }),
      contact({ id: "local-2", name: " Taylor  Lee " }),
    ]);
    const remote = workspace([contact({ id: "remote", name: "TAYLOR LEE" })]);

    expect((await mergeCloudWorkspaces(local, remote)).contacts).toHaveLength(3);
  });

  it("preserves playbooks, feedback, outcomes, documents, and draft history", async () => {
    const local = workspace([contact({
      id: "local", profileUrl: "https://linkedin.com/in/merge", documents: [{ id: "local-doc", name: "Local", text: "local", createdAt: "2026-08-01T00:00:00.000Z" }],
      outcomes: [{ id: "local-outcome", result: "positive", note: "local", createdAt: "2026-08-01T00:00:00.000Z" }],
      draftHistory: [{ id: "local-draft", agenda: "local", drafts: ["One", "Two", "Three"], createdAt: "2026-08-01T00:00:00.000Z" }],
    })]);
    local.guidance.playbooks["Network Marketing"].boundaries = "LOCAL RULE";
    local.feedback = [{ id: "local-feedback", contactId: "local", role: "Socializing/Networking", relationshipStage: "new_connection", conversationGoal: "", provider: "unknown", modelId: "", action: "accepted", draft: "draft", preferredResponse: "draft", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, rating: "useful", note: "", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" }];
    const remote = workspace([contact({
      id: "remote", profileUrl: "https://www.linkedin.com/in/merge/", documents: [{ id: "remote-doc", name: "Remote", text: "remote", createdAt: "2026-08-02T00:00:00.000Z" }],
      outcomes: [{ id: "remote-outcome", result: "neutral", note: "remote", createdAt: "2026-08-02T00:00:00.000Z" }],
      draftHistory: [{ id: "remote-draft", agenda: "remote", drafts: ["Four", "Five", "Six"], createdAt: "2026-08-02T00:00:00.000Z" }],
    })]);
    remote.feedback = [{ id: "remote-feedback", contactId: "remote", role: "Socializing/Networking", relationshipStage: "new_connection", conversationGoal: "", provider: "unknown", modelId: "", action: "rejected", draft: "draft", preferredResponse: "", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, rating: "not-useful", note: "", createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" }];

    const merged = await mergeCloudWorkspaces(local, remote);
    expect(merged.contacts[0].documents.map((item) => item.id)).toEqual(["local-doc", "remote-doc"]);
    expect(merged.contacts[0].outcomes.map((item) => item.id)).toEqual(["local-outcome", "remote-outcome"]);
    expect(merged.contacts[0].draftHistory?.map((item) => item.id)).toEqual(["local-draft", "remote-draft"]);
    expect(merged.feedback.map((item) => item.id)).toEqual(["local-feedback", "remote-feedback"]);
    expect(merged.guidance.playbooks["Network Marketing"].boundaries).toBe("LOCAL RULE");
  });

  it("uses encrypted identity tombstones to prevent resurrection on another device", async () => {
    const original = workspace([contact({ id: "device-a", name: "Deleted Person", profileUrl: "https://linkedin.com/in/deleted-person" })]);
    const deleted = await deleteContactEverywhere(original, "device-a", "2026-08-05T00:00:00.000Z");
    const otherDevice = workspace([contact({ id: "device-b", name: "Deleted Person", profileUrl: "https://www.linkedin.com/in/deleted-person/" })]);

    expect(deleted.contacts).toEqual([]);
    expect(deleted.deletionTombstones).toHaveLength(1);
    expect(deleted.deletionTombstones[0].contactId).toBe("device-a");
    expect(deleted.deletionTombstones[0].identityHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(JSON.stringify(deleted.deletionTombstones)).not.toContain("Deleted Person");
    expect(JSON.stringify(deleted.deletionTombstones)).not.toContain("deleted-person");
    expect((await mergeCloudWorkspaces(deleted, otherDevice)).contacts).toEqual([]);
  });

  it("merges bounded v14 learning metadata without losing encrypted local source references", async () => {
    const local = workspace([]);
    local.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "local", recordKind: "classifier", sanitizedPayload: classifierPayload("low"), sourceCollection: "stageTrainingRecords", sourceLocalId: "local-source", createdAt: "2026-08-01T00:00:00.000Z", expiresAt: "2027-08-01T00:00:00.000Z" }];
    const remote = workspace([]);
    remote.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "remote", recordKind: "classifier", sanitizedPayload: classifierPayload("medium"), sourceCollection: "stageTrainingRecords", sourceLocalId: "remote-source", createdAt: "2026-08-02T00:00:00.000Z", expiresAt: "2027-08-02T00:00:00.000Z" }];
    remote.cloudLearningSync = [{ recordId: "remote", contentDigest: "a".repeat(64), status: "pending", updatedAt: "2026-08-02T00:00:00.000Z" }];

    const merged = await mergeCloudWorkspaces(local, remote);
    expect(merged.pendingLearningRecords.map((row) => row.recordId)).toEqual(["local", "remote"]);
    expect(merged.pendingLearningRecords.map((row) => row.sourceLocalId)).toEqual(["local-source", "remote-source"]);
    expect(merged.cloudLearningSync).toEqual(remote.cloudLearningSync);
  });

  it("does not resurrect acknowledged learning sources or pending rows from a stale recovery conflict", async () => {
    const remote = workspace([]);
    remote.stageTrainingRecords = ["acknowledged", "pending"].map((suffix) => ({ id: `stage-${suffix}`, featureSchemaVersion: 1 as const, role: "Human Resource" as const, messageCountBucket: "low" as const, hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection" as const, humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }));
    remote.pendingLearningRecords = ["acknowledged", "pending"].map((suffix) => ({ mutationKind: "record_upload" as const, recordId: `record-${suffix}`, recordKind: "classifier" as const, sanitizedPayload: classifierPayload("low"), sourceCollection: "stageTrainingRecords" as const, sourceLocalId: `stage-${suffix}`, createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }));
    const local = structuredClone(remote);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: [{ recordId: "record-acknowledged", contentDigest: "a".repeat(64) }], duplicates: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const acknowledged = await syncPendingLearningRecords(local, new Date("2026-08-09T01:00:00.000Z"));
    const merged = await mergeCloudWorkspaces(acknowledged, remote);

    expect(merged.pendingLearningRecords.map((row) => row.recordId)).toEqual(["record-pending"]);
    expect(merged.stageTrainingRecords.map((row) => row.id)).toEqual(["stage-pending"]);
    expect(merged.cloudLearningSync.map((row) => row.recordId)).toEqual(["record-acknowledged"]);
  });

  it("does not resurrect individually deleted sync metadata from a stale recovery conflict", async () => {
    const remote = workspace([]);
    remote.cloudLearningSync = [
      { recordId: "record-deleted", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" },
      { recordId: "record-retained", contentDigest: "b".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];
    const local = clearDeletedCloudLearningSyncMetadata(structuredClone(remote), "record-deleted");

    expect((await mergeCloudWorkspaces(local, remote)).cloudLearningSync.map((row) => row.recordId)).toEqual(["record-retained"]);
  });

  it("does not resurrect globally cleared eligible learning from a stale recovery conflict", async () => {
    const remote = workspace([]);
    remote.feedback = [
      { id: "eligible", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "Keep eligible feedback", outcome: "", reason: "", origin: "independently_user_authored", independentlyAuthoredAttested: true, eligibleForRetrieval: true, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
      { id: "ordinary", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "Ordinary feedback", preferredResponse: "", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];
    remote.stageTrainingRecords = [{ id: "stage-1", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }];
    remote.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-1", recordKind: "classifier", sanitizedPayload: classifierPayload("low"), sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-1", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];
    remote.cloudLearningSync = [{ recordId: "record-2", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" }];
    const local = clearDisabledCloudLearningState(structuredClone(remote));

    const merged = await mergeCloudWorkspaces(local, remote);
    expect(merged.feedback.map((row) => row.id)).toEqual(["ordinary"]);
    expect(merged.stageTrainingRecords).toEqual([]);
    expect(merged.pendingLearningRecords).toEqual([]);
    expect(merged.cloudLearningSync).toEqual([]);
  });

  it("retains the newest learning deletion markers when the encrypted marker bound is exceeded", async () => {
    const local = workspace([]);
    local.cloudLearningDeletionMarkers = [{ recordId: "record-newest", disposition: "deleted", sourceCollection: "", sourceLocalId: "", deletedAt: "2026-08-09T12:00:00.000Z" }];
    const remote = workspace([]);
    remote.cloudLearningDeletionMarkers = Array.from({ length: 1_000 }, (_, index) => ({
      recordId: `record-${index}`,
      disposition: "deleted" as const,
      sourceCollection: "" as const,
      sourceLocalId: "",
      deletedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)).toISOString(),
    }));
    remote.cloudLearningSync = [{ recordId: "record-newest", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T11:00:00.000Z" }];

    const merged = await mergeCloudWorkspaces(local, remote);
    const staleConflict = await mergeCloudWorkspaces(merged, remote);

    expect(merged.cloudLearningDeletionMarkers).toHaveLength(1_000);
    expect(merged.cloudLearningDeletionMarkers.some((marker) => marker.recordId === "record-newest")).toBe(true);
    expect(staleConflict.cloudLearningSync).toEqual([]);
  });

  it("compares learning clear cutoffs by instant instead of timestamp spelling", async () => {
    const local = workspace([]);
    local.cloudLearningClearedAt = "2026-08-09T05:00:00+02:00";
    const remote = workspace([]);
    remote.cloudLearningClearedAt = "2026-08-09T04:00:00.000Z";
    remote.feedback = [{ id: "stale-offset", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "Stale", outcome: "", reason: "", origin: "independently_user_authored", independentlyAuthoredAttested: true, eligibleForRetrieval: true, enabled: true, createdAt: "2026-08-09T05:00:00+02:00", updatedAt: "2026-08-09T05:00:00+02:00" }];
    remote.stageTrainingRecords = [{ id: "stale-stage-offset", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T05:00:00+02:00" }];
    remote.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "stale-pending-offset", recordKind: "classifier", sanitizedPayload: classifierPayload("low"), sourceCollection: "stageTrainingRecords", sourceLocalId: "stale-stage-offset", createdAt: "2026-08-09T05:00:00+02:00", expiresAt: "2027-08-09T05:00:00+02:00" }];
    remote.cloudLearningSync = [{ recordId: "stale-sync-offset", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T05:00:00+02:00" }];

    const merged = await mergeCloudWorkspaces(local, remote);

    expect(merged.cloudLearningClearedAt).toBe("2026-08-09T04:00:00.000Z");
    expect(merged.feedback).toEqual([]);
    expect(merged.stageTrainingRecords).toEqual([]);
    expect(merged.pendingLearningRecords).toEqual([]);
    expect(merged.cloudLearningSync).toEqual([]);
  });
});

function classifierPayload(messageCountBucket: "low" | "medium") {
  return {
    recordKind: "classifier",
    roleId: "human_resource",
    relationshipStage: "new_connection",
    goalCategory: "connect",
    provenance: "human_confirmed",
    classifierFeatures: { messageCountBucket, hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false },
  };
}
