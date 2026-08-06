import type { WorkspaceData } from "./workspaceTypes";

function isRetained(createdAt: string, retentionDays: number, now: number): boolean {
  if (retentionDays === 0) return true;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= now - retentionDays * 24 * 60 * 60 * 1000;
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
    feedback: workspace.feedback.filter((item) => isRetained(item.createdAt, retentionByContact.get(item.contactId) ?? 90, now)),
    aiUsage: (workspace.aiUsage ?? []).filter((item) => isRetained(item.createdAt, retentionByContact.get(item.contactId) ?? 90, now)),
    deletionTombstones: (workspace.deletionTombstones ?? []).filter((item) => isRetained(item.deletedAt, 90, now)),
  };
}
