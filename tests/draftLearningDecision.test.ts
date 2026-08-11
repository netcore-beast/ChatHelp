import { describe, expect, it } from "vitest";
import {
  acknowledgeDraftLearningDecision,
  clearDraftLearningDecision,
  draftLearningDecisionRecordId,
  failDraftLearningDecision,
  stageDraftLearningDecision,
} from "../src/lib/draftLearningDecision";
import { clearDisabledCloudLearningState } from "../src/lib/cloudLearning";
import { mergeCloudWorkspaces } from "../src/lib/cloudWorkspaceMerge";
import { normalizeWorkspace } from "../src/lib/secureVault";
import { createEmptyWorkspace, type Contact, type DraftLearningDecisionPayload, type WorkspaceData } from "../src/lib/workspaceTypes";

const DRAFT_ID = "draft-00000000-0000-4000-8000-000000000001";
const RECORD_ID = "learning-decision-draft-00000000-0000-4000-8000-000000000001";
const NOW = "2026-08-10T09:00:00.000Z";

function contactFixture(): Contact {
  return {
    id: "contact-1", name: "Alex", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
    chat: [], documents: [], outcomes: [], retentionDays: 90, labels: [], pipelineStage: "inbox", notes: "",
    draftHistory: [{ id: DRAFT_ID, agenda: "", drafts: ["Draft"], createdAt: NOW }],
  };
}

function workspaceWithDraft(): WorkspaceData {
  return { ...createEmptyWorkspace(), contacts: [contactFixture()] };
}

function evaluationMutation(action: "useful" | "not_useful"): DraftLearningDecisionPayload {
  return { kind: "evaluation", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", action };
}

describe("draft learning decisions", () => {
  it("migrates v14 to v15 without inventing draft decisions", () => {
    const migrated = normalizeWorkspace({ ...workspaceWithDraft(), version: 14 });
    expect(migrated.version).toBe(15);
    expect(migrated.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
  });

  it("keeps only the newest pending mutation for one draft decision", () => {
    const stagedUseful = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date("2026-08-10T10:00:00.000Z"));
    const stagedNegative = stageDraftLearningDecision(stagedUseful, "contact-1", DRAFT_ID, evaluationMutation("not_useful"), new Date("2026-08-10T10:01:00.000Z"));
    expect(stagedNegative.pendingLearningRecords.filter((item) => item.recordId === RECORD_ID)).toHaveLength(1);
    expect(stagedNegative.contacts[0].draftHistory?.[0].learningDecision?.state).toBe("not_useful");
  });

  it("acknowledges only the current matching decision and preserves newer local state", () => {
    const useful = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date(NOW));
    const authored = stageDraftLearningDecision(useful, "contact-1", DRAFT_ID, {
      kind: "generative", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect",
      provenance: "independently_user_authored", target: "My original reply", rightsAttested: true, privacyAttested: true,
    }, new Date("2026-08-10T10:00:00.000Z"));
    const unchanged = acknowledgeDraftLearningDecision(authored, { recordId: RECORD_ID, decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T10:01:00.000Z" });
    expect(unchanged).toBe(authored);
    const acknowledged = acknowledgeDraftLearningDecision(authored, { recordId: RECORD_ID, decision: "authored", recordKind: "generative", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T10:01:00.000Z" });
    expect(acknowledged.pendingLearningRecords).toEqual([]);
    expect(acknowledged.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ state: "authored", syncStatus: "synced" });
  });

  it("does not mark an authored replacement failed when an older evaluation request fails late", () => {
    const negative = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("not_useful"), new Date(NOW));
    const authored = stageDraftLearningDecision(negative, "contact-1", DRAFT_ID, {
      kind: "generative", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect",
      provenance: "independently_user_authored", target: "My original reply", rightsAttested: true, privacyAttested: true,
    }, new Date("2026-08-10T10:00:01.000Z"));

    const unchanged = failDraftLearningDecision(authored, RECORD_ID, new Date("2026-08-10T10:00:02.000Z"), evaluationMutation("not_useful"));

    expect(unchanged).toBe(authored);
    expect(unchanged.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ state: "authored", syncStatus: "pending" });
  });

  it("does not acknowledge or fail a newer same-state mutation with an older mutation identity", () => {
    const first = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date("2026-08-10T10:00:00.000Z"));
    const older = first.pendingLearningRecords[0];
    if (older.mutationKind !== "draft_decision") throw new Error("expected a direct decision mutation");
    const newer = stageDraftLearningDecision(first, "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date("2026-08-10T10:00:01.000Z"));
    const acknowledged = acknowledgeDraftLearningDecision(newer, { recordId: RECORD_ID, decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T10:00:02.000Z" }, older);
    const failed = failDraftLearningDecision(newer, RECORD_ID, new Date("2026-08-10T10:00:02.000Z"), older);

    expect(acknowledged).toBe(newer);
    expect(failed).toBe(newer);
    expect(newer.pendingLearningRecords[0]).toMatchObject({ createdAt: "2026-08-10T10:00:01.000Z" });
  });

  it("retains a pending direct decision across vault reload and recovery merge", async () => {
    const staged = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("not_useful"), new Date("2026-08-10T10:00:00.000Z"));
    const reloaded = normalizeWorkspace(JSON.parse(JSON.stringify(staged)));
    const recovered = await mergeCloudWorkspaces(workspaceWithDraft(), reloaded);

    expect(reloaded.pendingLearningRecords).toHaveLength(1);
    expect(recovered.pendingLearningRecords).toHaveLength(1);
    expect(recovered.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ recordId: RECORD_ID, state: "not_useful", syncStatus: "pending" });
  });

  it("marks the current decision failed and clears it with a deletion tombstone", () => {
    const staged = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date(NOW));
    const failed = failDraftLearningDecision(staged, RECORD_ID, new Date("2026-08-10T10:01:00.000Z"));
    expect(failed.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ syncStatus: "failed" });
    const cleared = clearDraftLearningDecision(failed, RECORD_ID, new Date("2026-08-10T10:02:00.000Z"));
    expect(cleared.pendingLearningRecords).toEqual([]);
    expect(cleared.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
    expect(cleared.cloudLearningDeletionMarkers).toContainEqual(expect.objectContaining({ recordId: RECORD_ID, disposition: "deleted", sourceCollection: "draftHistory" }));
  });

  it("does not replace a newer deletion tombstone while clearing a decision", () => {
    const staged = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date(NOW));
    const withNewerTombstone = {
      ...staged,
      cloudLearningDeletionMarkers: [{ recordId: RECORD_ID, disposition: "deleted" as const, sourceCollection: "draftHistory" as const, sourceLocalId: DRAFT_ID, deletedAt: "2026-08-10T12:00:00.000Z" }],
    };
    const cleared = clearDraftLearningDecision(withNewerTombstone, RECORD_ID, new Date("2026-08-10T10:00:00.000Z"));
    expect(cleared.cloudLearningDeletionMarkers).toContainEqual(expect.objectContaining({ recordId: RECORD_ID, deletedAt: "2026-08-10T12:00:00.000Z" }));
  });

  it("keeps valid metadata but discards malformed metadata during vault normalization", () => {
    const valid = normalizeWorkspace({ ...workspaceWithDraft(), contacts: [{ ...contactFixture(), draftHistory: [{ ...contactFixture().draftHistory![0], learningDecision: { recordId: RECORD_ID, state: "useful", syncStatus: "pending", updatedAt: NOW } }] }] });
    const malformed = normalizeWorkspace({ ...workspaceWithDraft(), contacts: [{ ...contactFixture(), draftHistory: [{ ...contactFixture().draftHistory![0], learningDecision: { recordId: RECORD_ID, state: "useful", syncStatus: "pending", updatedAt: NOW, extra: true } }] }] });
    expect(valid.contacts[0].draftHistory?.[0].learningDecision).toEqual({ recordId: RECORD_ID, state: "useful", syncStatus: "pending", updatedAt: NOW });
    expect(malformed.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
  });

  it.each([
    ["an invalid record ID", { recordId: "UPPERCASE", state: "useful", syncStatus: "pending", updatedAt: NOW }],
    ["an invalid state", { recordId: RECORD_ID, state: "maybe", syncStatus: "pending", updatedAt: NOW }],
    ["an invalid sync status", { recordId: RECORD_ID, state: "useful", syncStatus: "later", updatedAt: NOW }],
    ["a non-canonical timestamp", { recordId: RECORD_ID, state: "useful", syncStatus: "pending", updatedAt: "2026-08-10T05:00:00-04:00" }],
  ])("discards %s decision metadata during vault normalization", (_description, learningDecision) => {
    const migrated = normalizeWorkspace({ ...workspaceWithDraft(), contacts: [{ ...contactFixture(), draftHistory: [{ ...contactFixture().draftHistory![0], learningDecision }] }] });
    expect(migrated.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
  });

  it("uses the newest decision mutation and authored state when merging a timestamp tie", async () => {
    const local = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("not_useful"), new Date("2026-08-10T10:00:00.000Z"));
    const remote = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, {
      kind: "generative", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect",
      provenance: "independently_user_authored", target: "My original reply", rightsAttested: true, privacyAttested: true,
    }, new Date("2026-08-10T10:00:00.000Z"));
    const merged = await mergeCloudWorkspaces(local, remote);
    expect(merged.contacts[0].draftHistory?.[0].learningDecision?.state).toBe("authored");
    expect(merged.pendingLearningRecords.filter((record) => record.recordId === RECORD_ID)).toHaveLength(1);
    expect(merged.pendingLearningRecords[0].mutationKind).toBe("draft_decision");
  });

  it("suppresses stale recovery decisions after a deletion tombstone", async () => {
    const stale = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date(NOW));
    const cleared = clearDraftLearningDecision(stale, RECORD_ID, new Date("2026-08-10T10:00:00.000Z"));
    const merged = await mergeCloudWorkspaces(cleared, stale);
    expect(merged.pendingLearningRecords).toEqual([]);
    expect(merged.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
  });

  it("removes decisions with other learning state when cloud learning is disabled", () => {
    const staged = stageDraftLearningDecision(workspaceWithDraft(), "contact-1", DRAFT_ID, evaluationMutation("useful"), new Date(NOW));
    const cleared = clearDisabledCloudLearningState(staged, new Date("2026-08-10T10:00:00.000Z"));
    expect(cleared.pendingLearningRecords).toEqual([]);
    expect(cleared.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
    expect(cleared.cloudLearningClearedAt).toBe("2026-08-10T10:00:00.000Z");
  });

  it("derives a bounded stable record ID", () => {
    expect(draftLearningDecisionRecordId(DRAFT_ID)).toBe(RECORD_ID);
    expect(() => draftLearningDecisionRecordId("A".repeat(64))).toThrow("Draft history ID cannot form");
  });
});
