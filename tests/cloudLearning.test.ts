import { describe, expect, it, vi } from "vitest";
import { applyCloudLearningSyncDelta, clearDeletedCloudLearningSyncMetadata, clearDisabledCloudLearningState, deleteCloudLearningRecord, disableAndDeleteCloudLearning, parseDraftLearningDecisionResponse, putDraftLearningDecision, readCloudLearningRecords, readCloudLearningStatus, syncPendingDraftLearningDecisions, syncPendingLearningRecords, updateCloudLearningPreference, uploadCloudLearningRecords } from "../src/lib/cloudLearning";
import { stageDraftLearningDecision } from "../src/lib/draftLearningDecision";
import { createEmptyWorkspace, type Contact, type DraftLearningDecisionPayload, type WorkspaceData } from "../src/lib/workspaceTypes";

const DECISION_DRAFT_ID = "draft-00000000-0000-4000-8000-000000000001";
const DECISION_RECORD_ID = "learning-decision-draft-00000000-0000-4000-8000-000000000001";

function usefulDecision(): Extract<DraftLearningDecisionPayload, { kind: "evaluation" }> {
  return { kind: "evaluation", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", action: "useful" };
}

function authoredDecision(): Extract<DraftLearningDecisionPayload, { kind: "generative" }> {
  return {
    kind: "generative", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect",
    provenance: "independently_user_authored", target: "My independent response", rightsAttested: true, privacyAttested: true,
  };
}

function decisionResponse(overrides: Partial<Record<string, unknown>> = {}): Response {
  return okJson({
    recordId: DECISION_RECORD_ID,
    decision: "useful",
    recordKind: "evaluation",
    contentDigest: "a".repeat(64),
    changed: true,
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides,
  });
}

function workspaceWithDecisionDraft(): WorkspaceData {
  const contact: Contact = {
    id: "contact-1", name: "Alex", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
    chat: [], documents: [], outcomes: [], retentionDays: 90, labels: [], pipelineStage: "inbox", notes: "",
    draftHistory: [{ id: DECISION_DRAFT_ID, agenda: "", drafts: ["Draft"], createdAt: "2026-08-10T09:00:00.000Z" }],
  };
  return { ...createEmptyWorkspace(), contacts: [contact] };
}

function okJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("cloud learning client", () => {
  it("uses same-origin credentials and no-store for learning status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      enabled: true,
      noticeVersion: "2026-08-09-v1",
      retentionDays: 365,
      counts: { classifier: 0, evaluation: 0, generative: 0 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readCloudLearningStatus()).resolves.toEqual({
      enabled: true,
      noticeVersion: "2026-08-09-v1",
      retentionDays: 365,
      counts: { classifier: 0, evaluation: 0, generative: 0 },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/learning/status", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  it("reads a bounded strict page through the same origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      records: [{
        recordId: "record-1",
        recordKind: "classifier",
        roleId: "human_resource",
        relationshipStage: "new_connection",
        goalCategory: "connect",
        classifierFeatures: {
          messageCountBucket: "low",
          hasIncomingQuestion: false,
          hasNeedSignal: false,
          hasPermissionSignal: false,
          hasValueDiscussionSignal: false,
          hasNextStepSignal: false,
        },
        enabled: true,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        expiresAt: "2027-08-09T00:00:00.000Z",
      }],
      nextCursor: null,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readCloudLearningRecords()).resolves.toEqual({
      records: [{
        recordId: "record-1",
        recordKind: "classifier",
        roleId: "human_resource",
        relationshipStage: "new_connection",
        goalCategory: "connect",
        classifierFeatures: {
          messageCountBucket: "low",
          hasIncomingQuestion: false,
          hasNeedSignal: false,
          hasPermissionSignal: false,
          hasValueDiscussionSignal: false,
          hasNextStepSignal: false,
        },
        enabled: true,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        expiresAt: "2027-08-09T00:00:00.000Z",
      }],
      nextCursor: null,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/learning/records", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  it("rejects classifier management metadata beyond the strict six-field allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({
      records: [{
        recordId: "record-private-extra",
        recordKind: "classifier",
        roleId: "human_resource",
        relationshipStage: "new_connection",
        goalCategory: "connect",
        classifierFeatures: {
          messageCountBucket: "low",
          hasIncomingQuestion: false,
          hasNeedSignal: false,
          hasPermissionSignal: false,
          hasValueDiscussionSignal: false,
          hasNextStepSignal: false,
          semanticTokens: ["must-not-cross-client-boundary"],
        },
        enabled: true,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        expiresAt: "2027-08-09T00:00:00.000Z",
      }],
      nextCursor: null,
    })));

    await expect(readCloudLearningRecords()).rejects.toThrow("invalid cloud learning response");
  });

  it("removes pending content only after a matching server acknowledgement", async () => {
    const workspace = createEmptyWorkspace();
    workspace.stageTrainingRecords = [{
      id: "stage-1",
      featureSchemaVersion: 1,
      role: "Human Resource",
      messageCountBucket: "low",
      hasIncomingQuestion: false,
      hasNeedSignal: false,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: [],
      confirmedStage: "new_connection",
      humanConfirmed: true,
      createdAt: "2026-08-09T00:00:00.000Z",
    }];
    workspace.pendingLearningRecords = [{
      mutationKind: "record_upload",
      recordId: "record-1",
      recordKind: "classifier",
      sanitizedPayload: {
        recordKind: "classifier",
        roleId: "human_resource",
        relationshipStage: "new_connection",
        goalCategory: "connect",
        provenance: "human_confirmed",
        classifierFeatures: {
          messageCountBucket: "low",
          hasIncomingQuestion: false,
          hasNeedSignal: false,
          hasPermissionSignal: false,
          hasValueDiscussionSignal: false,
          hasNextStepSignal: false,
        },
      },
      sourceCollection: "stageTrainingRecords",
      sourceLocalId: "stage-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    }];
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(okJson({
        accepted: [{ recordId: "record-1", contentDigest: "a".repeat(64) }],
        duplicates: [],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const failed = await syncPendingLearningRecords(workspace);
    expect(failed.pendingLearningRecords).toHaveLength(1);
    expect(failed.stageTrainingRecords).toHaveLength(1);

    const synced = await syncPendingLearningRecords(failed);
    expect(synced.pendingLearningRecords).toEqual([]);
    expect(synced.stageTrainingRecords).toEqual([]);
    expect(synced.cloudLearningSync).toEqual([expect.objectContaining({
      recordId: "record-1",
      contentDigest: "a".repeat(64),
      status: "synced",
    })]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({
      records: [{
        recordId: "record-1",
        record: workspace.pendingLearningRecords[0].mutationKind === "record_upload" ? workspace.pendingLearningRecords[0].sanitizedPayload : undefined,
      }],
    });
  });

  it("syncs pending records in bounded batches", async () => {
    const workspace = createEmptyWorkspace();
    workspace.pendingLearningRecords = Array.from({ length: 26 }, (_, index) => ({
      mutationKind: "record_upload" as const,
      recordId: `record-${index}`,
      recordKind: "classifier" as const,
      sanitizedPayload: { recordKind: "classifier", sample: index },
      sourceCollection: "stageTrainingRecords" as const,
      sourceLocalId: `stage-${index}`,
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    }));
    const fetchMock = vi.fn().mockImplementation(async (_path, init) => {
      const ids = JSON.parse(String(init.body)).records.map((record: { recordId: string }) => record.recordId);
      return okJson({ accepted: ids.map((recordId: string) => ({ recordId, contentDigest: "b".repeat(64) })), duplicates: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncPendingLearningRecords(workspace)).resolves.toMatchObject({ pendingLearningRecords: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).records).toHaveLength(25);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).records).toHaveLength(1);
  });

  it("updates the preference only through the same-origin learning endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ enabled: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateCloudLearningPreference(false)).resolves.toEqual({ enabled: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/learning/preference", {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  });

  it("requires an individual deletion acknowledgement for the requested record", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ deleted: true, recordId: "record-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteCloudLearningRecord("record-1")).resolves.toEqual({ deleted: true, recordId: "record-1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/learning/records/record-1", {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  it("disables and deletes cloud learning through the same-origin endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ enabled: false, deleted: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(disableAndDeleteCloudLearning()).resolves.toEqual({ enabled: false, deleted: 3 });
    expect(fetchMock).toHaveBeenCalledWith("/api/learning", {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  it("clears only eligible local learning state after disable acknowledgement", () => {
    const workspace = createEmptyWorkspace();
    workspace.contacts = [{
      id: "contact-1", name: "Alex", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
      chat: [{ id: "message-1", role: "them", body: "Keep this ordinary message", createdAt: "2026-08-09T00:00:00.000Z" }],
      documents: [], outcomes: [], retentionDays: 90,
      draftHistory: [{ id: "draft-1", agenda: "Keep this draft", drafts: ["Ordinary draft"], createdAt: "2026-08-09T00:00:00.000Z" }],
    }];
    workspace.feedback = [
      { id: "eligible", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "", outcome: "", reason: "", origin: "independently_user_authored", independentlyAuthoredAttested: true, eligibleForRetrieval: true, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
      { id: "ordinary-feedback", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];
    workspace.stageTrainingRecords = [{ id: "stage-1", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }];
    workspace.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-1", recordKind: "classifier", sanitizedPayload: { recordKind: "classifier" }, sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-1", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];
    workspace.cloudLearningSync = [{ recordId: "record-1", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" }];

    const cleared = clearDisabledCloudLearningState(workspace);
    expect(cleared.feedback.map((item) => item.id)).toEqual(["ordinary-feedback"]);
    expect(cleared.stageTrainingRecords).toEqual([]);
    expect(cleared.pendingLearningRecords).toEqual([]);
    expect(cleared.cloudLearningSync).toEqual([]);
    expect(cleared.contacts[0].chat).toEqual(workspace.contacts[0].chat);
    expect(cleared.contacts[0].draftHistory).toEqual(workspace.contacts[0].draftHistory);
  });

  it("removes matching pending and sync metadata after individual deletion so retries cannot recreate it", () => {
    const workspace = createEmptyWorkspace();
    workspace.stageTrainingRecords = [
      { id: "stage-1", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" },
      { id: "stage-keep", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" },
    ];
    workspace.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-1", recordKind: "classifier", sanitizedPayload: { recordKind: "classifier" }, sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-1", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];
    workspace.cloudLearningSync = [
      { recordId: "record-1", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" },
      { recordId: "record-2", contentDigest: "b".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];

    const updated = clearDeletedCloudLearningSyncMetadata(workspace, "record-1");
    expect(updated.cloudLearningSync.map((item) => item.recordId)).toEqual(["record-2"]);
    expect(updated.pendingLearningRecords).toEqual([]);
    expect(updated.stageTrainingRecords.map((item) => item.id)).toEqual(["stage-keep"]);
    expect(updated.cloudLearningDeletionMarkers).toEqual([
      expect.objectContaining({ recordId: "record-1", disposition: "deleted", sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-1" }),
    ]);
  });

  it("removes only the eligible feedback source captured by a deleted pending record", () => {
    const workspace = createEmptyWorkspace();
    workspace.feedback = [
      { id: "feedback-delete", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "Delete", outcome: "", reason: "", origin: "independently_user_authored", independentlyAuthoredAttested: true, eligibleForRetrieval: true, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
      { id: "feedback-keep", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "Ordinary", preferredResponse: "", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];
    workspace.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-feedback", recordKind: "evaluation", sanitizedPayload: { recordKind: "evaluation" }, sourceCollection: "feedback", sourceLocalId: "feedback-delete", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];

    const updated = clearDeletedCloudLearningSyncMetadata(workspace, "record-feedback");

    expect(updated.feedback.map((item) => item.id)).toEqual(["feedback-keep"]);
    expect(updated.pendingLearningRecords).toEqual([]);
  });

  it("retains shared source metadata until its final pending record is deleted", () => {
    const workspace = createEmptyWorkspace();
    workspace.stageTrainingRecords = [{ id: "shared-stage", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }];
    workspace.pendingLearningRecords = ["record-first", "record-last"].map((recordId) => ({ mutationKind: "record_upload" as const, recordId, recordKind: "classifier" as const, sanitizedPayload: { recordKind: "classifier" }, sourceCollection: "stageTrainingRecords" as const, sourceLocalId: "shared-stage", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }));

    const afterFirst = clearDeletedCloudLearningSyncMetadata(workspace, "record-first");
    expect(afterFirst.stageTrainingRecords.map((item) => item.id)).toEqual(["shared-stage"]);
    expect(afterFirst.pendingLearningRecords.map((item) => item.recordId)).toEqual(["record-last"]);

    const afterLast = clearDeletedCloudLearningSyncMetadata(afterFirst, "record-last");
    expect(afterLast.stageTrainingRecords).toEqual([]);
    expect(afterLast.pendingLearningRecords).toEqual([]);
  });

  it("bounds local deletion markers by newest deletion time rather than insertion order", () => {
    const workspace = createEmptyWorkspace();
    workspace.cloudLearningDeletionMarkers = [
      { recordId: "record-retained", disposition: "deleted", sourceCollection: "", sourceLocalId: "", deletedAt: "2026-08-09T00:00:00.000Z" },
      ...Array.from({ length: 999 }, (_, index) => ({ recordId: `older-${index}`, disposition: "deleted" as const, sourceCollection: "" as const, sourceLocalId: "", deletedAt: "2026-08-01T00:00:00.000Z" })),
    ];

    const updated = clearDeletedCloudLearningSyncMetadata(workspace, "record-added", new Date("2026-08-02T00:00:00.000Z"));

    expect(updated.cloudLearningDeletionMarkers).toHaveLength(1_000);
    expect(updated.cloudLearningDeletionMarkers.map((marker) => marker.recordId)).toEqual(expect.arrayContaining(["record-retained", "record-added"]));
  });

  it("applies only the learning acknowledgement delta to a concurrently edited workspace", async () => {
    const baseline = createEmptyWorkspace();
    baseline.guidance.voice = "Stale voice";
    baseline.feedback = [{ id: "ordinary-deleted", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "Ordinary", preferredResponse: "", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" }];
    baseline.stageTrainingRecords = [{ id: "stage-1", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }];
    baseline.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-1", recordKind: "classifier", sanitizedPayload: { recordKind: "classifier" }, sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-1", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ accepted: [{ recordId: "record-1", contentDigest: "a".repeat(64) }], duplicates: [] })));
    const synced = await syncPendingLearningRecords(baseline, new Date("2026-08-09T01:00:00.000Z"));
    const latest = structuredClone(baseline);
    latest.guidance.voice = "";
    latest.feedback = [];

    const reconciled = applyCloudLearningSyncDelta(latest, baseline, synced);

    expect(reconciled.guidance.voice).toBe("");
    expect(reconciled.feedback).toEqual([]);
    expect(reconciled.stageTrainingRecords).toEqual([]);
    expect(reconciled.pendingLearningRecords).toEqual([]);
    expect(reconciled.cloudLearningSync).toEqual([expect.objectContaining({ recordId: "record-1", status: "synced" })]);
  });

  it("rejects a learning status response with extra keys", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({
      enabled: true,
      noticeVersion: "2026-08-09-v1",
      retentionDays: 365,
      counts: { classifier: 0, evaluation: 0, generative: 0 },
      accountId: "browser-controlled-value",
    })));

    await expect(readCloudLearningStatus()).rejects.toThrow("invalid cloud learning response");
  });

  it("rejects a JSON-looking response served with a non-JSON content type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      enabled: true,
      noticeVersion: "2026-08-09-v1",
      retentionDays: 365,
      counts: { classifier: 0, evaluation: 0, generative: 0 },
    }), { status: 200, headers: { "Content-Type": "text/html" } })));

    await expect(readCloudLearningStatus()).rejects.toThrow("invalid cloud learning response");
  });

  it("rejects a record page with an invalid server cursor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ records: [], nextCursor: "not-a-cursor" })));

    await expect(readCloudLearningRecords()).rejects.toThrow("invalid cloud learning response");
  });

  it("retains pending records when an upload acknowledgement is not for the submitted record", async () => {
    const workspace = createEmptyWorkspace();
    workspace.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-1", recordKind: "classifier", sanitizedPayload: { recordKind: "classifier" }, sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-1", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({
      accepted: [{ recordId: "record-2", contentDigest: "a".repeat(64) }],
      duplicates: [],
    })));

    await expect(syncPendingLearningRecords(workspace)).resolves.toEqual(workspace);
  });

  it("rejects an upload acknowledgement for an unsubmitted record", async () => {
    const record = {
      mutationKind: "record_upload" as const,
      recordId: "record-1",
      recordKind: "classifier" as const,
      sanitizedPayload: { recordKind: "classifier" },
      sourceCollection: "stageTrainingRecords" as const,
      sourceLocalId: "stage-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({
      accepted: [{ recordId: "record-2", contentDigest: "a".repeat(64) }],
      duplicates: [],
    })));

    await expect(uploadCloudLearningRecords([record])).rejects.toThrow("invalid cloud learning response");
  });

  it("uploads exact transient known identifiers for generative records and retains only opaque acknowledgement metadata", async () => {
    const workspace = createEmptyWorkspace();
    workspace.feedback = [{ id: "feedback-1", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "Hello [contact] at [company]", outcome: "", reason: "", origin: "independently_user_authored", independentlyAuthoredAttested: true, eligibleForRetrieval: true, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" }];
    const generativeRecord = {
      mutationKind: "record_upload" as const,
      recordId: "generative-1",
      recordKind: "generative" as const,
      sanitizedPayload: { recordKind: "generative", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", provenance: "independently_user_authored", target: "Hello [contact] at [company]", rightsAttested: true, privacyAttested: true },
      knownIdentifiers: { contactName: "Priya", company: "Contoso", profileUrl: "https://linkedin.example/priya", profileHandle: "@priya" },
      sourceCollection: "feedback" as const,
      sourceLocalId: "feedback-1",
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    };
    workspace.pendingLearningRecords = [generativeRecord];
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      accepted: [{ recordId: "generative-1", contentDigest: "d".repeat(64) }],
      duplicates: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const synced = await syncPendingLearningRecords(workspace);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ records: [{
      recordId: "generative-1",
      record: generativeRecord.sanitizedPayload,
      knownIdentifiers: generativeRecord.knownIdentifiers,
    }] });
    expect(synced.pendingLearningRecords).toEqual([]);
    expect(synced.feedback).toEqual([]);
    expect(synced.cloudLearningSync).toEqual([expect.objectContaining({ recordId: "generative-1", contentDigest: "d".repeat(64), status: "synced" })]);
    expect(JSON.stringify(synced.cloudLearningSync)).not.toContain("Priya");
    expect(JSON.stringify(synced.cloudLearningSync)).not.toContain("Contoso");
  });

  it("retries an already-sanitized persisted generative record with exact empty transient identifiers", async () => {
    const record = {
      mutationKind: "record_upload" as const,
      recordId: "generative-persisted",
      recordKind: "generative" as const,
      sanitizedPayload: { recordKind: "generative", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", provenance: "independently_user_authored", target: "Hello [contact]", rightsAttested: true, privacyAttested: true },
      sourceCollection: "feedback" as const,
      sourceLocalId: "feedback-persisted",
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      accepted: [{ recordId: "generative-persisted", contentDigest: "e".repeat(64) }],
      duplicates: [],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadCloudLearningRecords([record])).resolves.toEqual({
      accepted: [{ recordId: "generative-persisted", contentDigest: "e".repeat(64) }],
      duplicates: [],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ records: [{
      recordId: "generative-persisted",
      record: record.sanitizedPayload,
      knownIdentifiers: { contactName: "", company: "", profileUrl: "", profileHandle: "" },
    }] });
  });

  it("rejects numeric record IDs in strict record responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({
      records: [{
        recordId: 1,
        recordKind: "classifier",
        roleId: "human_resource",
        relationshipStage: "new_connection",
        goalCategory: "connect",
        enabled: true,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
        expiresAt: "2027-08-09T00:00:00.000Z",
      }],
      nextCursor: null,
    })));

    await expect(readCloudLearningRecords()).rejects.toThrow("invalid cloud learning response");
  });

  it("uses the same-origin no-store decision route and parses the exact response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(decisionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(putDraftLearningDecision(DECISION_RECORD_ID, { decision: usefulDecision() })).resolves.toMatchObject({
      recordId: DECISION_RECORD_ID,
      decision: "useful",
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/learning/decisions/${DECISION_RECORD_ID}`, {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: usefulDecision() }),
    });
  });

  it.each([
    ["missing response metadata", { recordId: DECISION_RECORD_ID, decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true }],
    ["response metadata with an extra key", { recordId: DECISION_RECORD_ID, decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T10:00:00.000Z", accountId: "must-not-cross" }],
    ["an invalid decision and record kind pair", { recordId: DECISION_RECORD_ID, decision: "authored", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T10:00:00.000Z" }],
    ["an unknown record kind", { recordId: DECISION_RECORD_ID, decision: "useful", recordKind: "classifier", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T10:00:00.000Z" }],
    ["a non-lowercase digest", { recordId: DECISION_RECORD_ID, decision: "useful", recordKind: "evaluation", contentDigest: "A".repeat(64), changed: true, updatedAt: "2026-08-10T10:00:00.000Z" }],
    ["a non-canonical timestamp", { recordId: DECISION_RECORD_ID, decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T06:00:00-04:00" }],
    ["a mismatched record ID", { recordId: "other-record", decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T10:00:00.000Z" }],
  ])("rejects %s from a draft decision response", (_description, value) => {
    expect(() => parseDraftLearningDecisionResponse(value, DECISION_RECORD_ID)).toThrow("invalid cloud learning response");
  });

  it("rejects a non-JSON draft decision acknowledgement and malformed record IDs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })));

    await expect(putDraftLearningDecision(DECISION_RECORD_ID, { decision: usefulDecision() })).rejects.toThrow("invalid cloud learning response");
    await expect(putDraftLearningDecision("UPPERCASE", { decision: usefulDecision() })).rejects.toThrow("Cloud learning decision is invalid");
  });

  it.each(["application/jsonp", "text/application/json"])("rejects a draft decision acknowledgement served as %s", async (contentType) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      recordId: DECISION_RECORD_ID,
      decision: "useful",
      recordKind: "evaluation",
      contentDigest: "a".repeat(64),
      changed: true,
      updatedAt: "2026-08-10T10:00:00.000Z",
    }), { status: 200, headers: { "Content-Type": contentType } })));

    await expect(putDraftLearningDecision(DECISION_RECORD_ID, { decision: usefulDecision() })).rejects.toThrow("invalid cloud learning response");
  });

  it("accepts a parameterized JSON media type for a draft decision acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      recordId: DECISION_RECORD_ID,
      decision: "useful",
      recordKind: "evaluation",
      contentDigest: "a".repeat(64),
      changed: true,
      updatedAt: "2026-08-10T10:00:00.000Z",
    }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } })));

    await expect(putDraftLearningDecision(DECISION_RECORD_ID, { decision: usefulDecision() })).resolves.toMatchObject({ recordId: DECISION_RECORD_ID });
  });

  it("retries only the latest mutation for a decision record", async () => {
    const useful = stageDraftLearningDecision(workspaceWithDecisionDraft(), "contact-1", DECISION_DRAFT_ID, usefulDecision(), new Date("2026-08-10T10:00:00.000Z"));
    const negative = stageDraftLearningDecision(useful, "contact-1", DECISION_DRAFT_ID, { ...usefulDecision(), action: "not_useful" }, new Date("2026-08-10T10:01:00.000Z"));
    const workspace = {
      ...negative,
      pendingLearningRecords: [...useful.pendingLearningRecords, ...negative.pendingLearningRecords],
    };
    const fetchMock = vi.fn().mockResolvedValue(decisionResponse({ decision: "not_useful" }));
    vi.stubGlobal("fetch", fetchMock);

    const synced = await syncPendingDraftLearningDecisions(workspace, () => {
      throw new Error("evaluation decisions must not resolve identifiers");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).decision.action).toBe("not_useful");
    expect(synced.pendingLearningRecords).toEqual([]);
    expect(synced.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ state: "not_useful", syncStatus: "synced" });
  });

  it("uses resolved identifiers only in the authored request and never returns them in workspace state", async () => {
    const workspace = stageDraftLearningDecision(workspaceWithDecisionDraft(), "contact-1", DECISION_DRAFT_ID, authoredDecision(), new Date("2026-08-10T10:00:00.000Z"));
    const identifiers = { contactName: "Priya", company: "Contoso", profileUrl: "https://linkedin.example/priya", profileHandle: "@priya" };
    const fetchMock = vi.fn().mockResolvedValue(decisionResponse({ decision: "authored", recordKind: "generative" }));
    vi.stubGlobal("fetch", fetchMock);

    const synced = await syncPendingDraftLearningDecisions(workspace, (sourceLocalId) => sourceLocalId === DECISION_DRAFT_ID ? identifiers : null);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ decision: authoredDecision(), knownIdentifiers: identifiers });
    expect(JSON.stringify(synced)).not.toContain("Priya");
    expect(JSON.stringify(synced)).not.toContain("Contoso");
    expect(JSON.stringify(synced)).not.toContain("linkedin.example/priya");
  });

  it("keeps an authored retry pending and marks it failed when current contact identifiers are unavailable", async () => {
    const workspace = stageDraftLearningDecision(workspaceWithDecisionDraft(), "contact-1", DECISION_DRAFT_ID, authoredDecision(), new Date("2026-08-10T10:00:00.000Z"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const retried = await syncPendingDraftLearningDecisions(workspace, () => null, new Date("2026-08-10T10:01:00.000Z"));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(retried.pendingLearningRecords).toEqual(workspace.pendingLearningRecords);
    expect(retried.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ state: "authored", syncStatus: "failed", updatedAt: "2026-08-10T10:01:00.000Z" });
  });

  it("does not send draft decision mutations through the generic upload route", async () => {
    const workspace = stageDraftLearningDecision(workspaceWithDecisionDraft(), "contact-1", DECISION_DRAFT_ID, usefulDecision(), new Date("2026-08-10T10:00:00.000Z"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncPendingLearningRecords(workspace)).resolves.toBe(workspace);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
