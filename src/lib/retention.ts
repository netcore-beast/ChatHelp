import type { WorkspaceData } from "./workspaceTypes";

export const LEARNING_RETENTION_DAYS = 365;

function isRetained(createdAt: string, retentionDays: number, now: number): boolean {
  if (retentionDays === 0) return true;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= now - retentionDays * 24 * 60 * 60 * 1000;
}

function hasNotExpired(expiresAt: string, now: number): boolean {
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp >= now;
}

export function applyRetention(workspace: WorkspaceData, now = Date.now()): WorkspaceData {
  const retentionByContact = new Map(workspace.contacts.map((contact) => [contact.id, contact.retentionDays]));
  return {
    ...workspace,
    contacts: workspace.contacts.map((contact) => ({
      ...contact,
      chat: contact.chat.filter((message) => isRetained(message.createdAt, contact.retentionDays, now)),
      documents: contact.documents.filter((document) => isRetained(document.createdAt, contact.retentionDays, now)),
      outcomes: contact.outcomes.filter((outcome) => isRetained(outcome.createdAt, contact.retentionDays, now)),
      draftHistory: (contact.draftHistory ?? []).filter((draft) => isRetained(draft.createdAt, contact.retentionDays, now)),
    })),
    feedback: workspace.feedback.filter((item) => isRetained(item.createdAt, LEARNING_RETENTION_DAYS, now)),
    aiUsage: (workspace.aiUsage ?? []).filter((item) => isRetained(item.createdAt, retentionByContact.get(item.contactId) ?? 90, now)),
    deletionTombstones: (workspace.deletionTombstones ?? []).filter((item) => isRetained(item.deletedAt, 90, now)),
    stageTrainingRecords: workspace.stageTrainingRecords.filter((item) => isRetained(item.createdAt, LEARNING_RETENTION_DAYS, now)),
    pendingLearningRecords: workspace.pendingLearningRecords.filter((item) => isRetained(item.createdAt, LEARNING_RETENTION_DAYS, now) && hasNotExpired(item.expiresAt, now)),
    cloudLearningSync: workspace.cloudLearningSync.filter((item) => isRetained(item.updatedAt, LEARNING_RETENTION_DAYS, now)),
    cloudLearningDeletionMarkers: workspace.cloudLearningDeletionMarkers.filter((item) => isRetained(item.deletedAt, LEARNING_RETENTION_DAYS, now)),
    cloudLearningClearedAt: workspace.cloudLearningClearedAt && isRetained(workspace.cloudLearningClearedAt, LEARNING_RETENTION_DAYS, now) ? workspace.cloudLearningClearedAt : "",
  };
}

export function applyLearningRetention(workspace: WorkspaceData, now = Date.now()): WorkspaceData {
  return applyRetention(workspace, now);
}
