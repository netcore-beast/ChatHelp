import type { DraftLearningDecision, DraftLearningDecisionPayload, DraftLearningDecisionState, PendingDraftLearningDecisionMutation, WorkspaceData } from "./workspaceTypes";

export const DRAFT_DECISION_RECORD_ID = /^[a-z0-9-]{1,64}$/u;
const RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

export function draftLearningDecisionRecordId(draftHistoryId: string): string {
  const recordId = `learning-decision-${draftHistoryId}`;
  if (!DRAFT_DECISION_RECORD_ID.test(recordId)) throw new Error("Draft history ID cannot form a learning decision ID.");
  return recordId;
}

export function decisionStateForPayload(decision: DraftLearningDecisionPayload): DraftLearningDecisionState {
  return decision.kind === "generative" ? "authored" : decision.action;
}

export interface DraftLearningDecisionAcknowledgement {
  recordId: string;
  decision: "useful" | "not_useful" | "authored";
  recordKind: "evaluation" | "generative";
  contentDigest: string;
  changed: boolean;
  updatedAt: string;
}

function updateDecision(workspace: WorkspaceData, recordId: string, update: (decision: DraftLearningDecision) => DraftLearningDecision | undefined): WorkspaceData {
  let changed = false;
  const contacts = workspace.contacts.map((contact) => ({
    ...contact,
    draftHistory: contact.draftHistory?.map((draft) => {
      if (draft.learningDecision?.recordId !== recordId) return draft;
      const learningDecision = update(draft.learningDecision);
      if (learningDecision === draft.learningDecision) return draft;
      changed = true;
      if (learningDecision) return { ...draft, learningDecision };
      const withoutDecision = { ...draft };
      delete withoutDecision.learningDecision;
      return withoutDecision;
    }),
  }));
  return changed ? { ...workspace, contacts } : workspace;
}

export function stageDraftLearningDecision(workspace: WorkspaceData, contactId: string, draftHistoryId: string, decision: DraftLearningDecisionPayload, now = new Date()): WorkspaceData {
  const recordId = draftLearningDecisionRecordId(draftHistoryId);
  const current = workspace.contacts.find((contact) => contact.id === contactId)?.draftHistory?.find((draft) => draft.id === draftHistoryId);
  if (!current || (current.learningDecision?.state === "authored" && decision.kind === "evaluation")) return workspace;
  const updatedAt = now.toISOString();
  const withDecision = {
    ...workspace,
    contacts: workspace.contacts.map((contact) => contact.id !== contactId ? contact : {
      ...contact,
      draftHistory: contact.draftHistory?.map((draft) => draft.id !== draftHistoryId ? draft : {
        ...draft,
        learningDecision: { recordId, state: decisionStateForPayload(decision), syncStatus: "pending" as const, updatedAt },
      }),
    }),
  };
  const pending = { mutationKind: "draft_decision" as const, recordId, decision, sourceCollection: "draftHistory" as const, sourceLocalId: draftHistoryId, createdAt: updatedAt, expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString() };
  return {
    ...withDecision,
    pendingLearningRecords: [
      ...workspace.pendingLearningRecords.filter((item) => !(item.mutationKind === "draft_decision" && item.recordId === recordId)),
      pending,
    ].slice(-1_000),
  };
}

export function acknowledgeDraftLearningDecision(workspace: WorkspaceData, response: DraftLearningDecisionAcknowledgement): WorkspaceData {
  const pending = workspace.pendingLearningRecords.find((item): item is PendingDraftLearningDecisionMutation => item.mutationKind === "draft_decision" && item.recordId === response.recordId);
  if (!pending || workspace.cloudLearningDeletionMarkers.some((marker) => marker.recordId === response.recordId)) return workspace;
  const state = decisionStateForPayload(pending.decision);
  const compatible = state === response.decision || response.decision === "authored" && state === "useful";
  if (!compatible) return workspace;
  const updated = updateDecision(workspace, response.recordId, (decision) => decision && decision.state === state
    ? { ...decision, state: response.decision, syncStatus: "synced", updatedAt: response.updatedAt }
    : decision);
  if (updated === workspace) return workspace;
  return { ...updated, pendingLearningRecords: updated.pendingLearningRecords.filter((item) => !(item.mutationKind === "draft_decision" && item.recordId === response.recordId)) };
}

export function failDraftLearningDecision(workspace: WorkspaceData, recordId: string, now = new Date()): WorkspaceData {
  return updateDecision(workspace, recordId, (decision) => decision?.syncStatus === "pending"
    ? { ...decision, syncStatus: "failed", updatedAt: now.toISOString() }
    : decision);
}

export function clearDraftLearningDecision(workspace: WorkspaceData, recordId: string, now = new Date()): WorkspaceData {
  const removed = updateDecision(workspace, recordId, () => undefined);
  const pending = removed.pendingLearningRecords.find((item): item is PendingDraftLearningDecisionMutation => item.mutationKind === "draft_decision" && item.recordId === recordId);
  if (removed === workspace && !pending) return workspace;
  const deletedAt = now.toISOString();
  const markers = new Map(removed.cloudLearningDeletionMarkers.map((marker) => [marker.recordId, marker]));
  const current = markers.get(recordId);
  const deletion = { recordId, disposition: "deleted" as const, sourceCollection: "draftHistory" as const, sourceLocalId: pending?.sourceLocalId ?? "", deletedAt };
  if (!current || current.disposition !== "deleted" || Date.parse(deletion.deletedAt) > Date.parse(current.deletedAt)) markers.set(recordId, deletion);
  return {
    ...removed,
    pendingLearningRecords: removed.pendingLearningRecords.filter((item) => !(item.mutationKind === "draft_decision" && item.recordId === recordId)),
    cloudLearningDeletionMarkers: [...markers.values()].sort((left, right) => Date.parse(left.deletedAt) - Date.parse(right.deletedAt) || left.recordId.localeCompare(right.recordId)).slice(-1_000),
  };
}
