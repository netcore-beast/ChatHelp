import type { Contact } from "./workspaceTypes";

export type ConversationStateCode = "archived" | "snoozed" | "follow-up-due" | "read-later" | "to-respond" | "awaiting-reply" | "no-messages" | "up-to-date";

export interface ConversationState {
  code: ConversationStateCode;
  label: string;
  explanation: string;
}

const STATES: Record<ConversationStateCode, ConversationState> = {
  archived: { code: "archived", label: "Archived", explanation: "This conversation is outside the active inbox." },
  snoozed: { code: "snoozed", label: "Snoozed", explanation: "This conversation is hidden until its snooze time." },
  "follow-up-due": { code: "follow-up-due", label: "Follow-up due", explanation: "A saved reminder or snooze time is due." },
  "read-later": { code: "read-later", label: "Read later", explanation: "You marked this conversation for later attention." },
  "to-respond": { code: "to-respond", label: "To respond", explanation: "The latest message is from the contact." },
  "awaiting-reply": { code: "awaiting-reply", label: "Awaiting reply", explanation: "The latest message is from you." },
  "no-messages": { code: "no-messages", label: "No messages", explanation: "No conversation messages are stored yet." },
  "up-to-date": { code: "up-to-date", label: "Up to date", explanation: "No reply or follow-up action is currently detected." },
};

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deriveConversationState(contact: Contact, now = Date.now()): ConversationState {
  if (contact.archivedAt || contact.pipelineStage === "done") return STATES.archived;
  const snoozedUntil = timestamp(contact.snoozedUntil);
  if (snoozedUntil > now) return STATES.snoozed;
  const followUpAt = timestamp(contact.followUpAt);
  if ((followUpAt > 0 && followUpAt <= now) || (snoozedUntil > 0 && snoozedUntil <= now)) return STATES["follow-up-due"];
  if (contact.readLater) return STATES["read-later"];
  const latest = contact.chat.at(-1);
  if (!latest) return STATES["no-messages"];
  if (latest.role === "them") return STATES["to-respond"];
  if (latest.role === "me") return STATES["awaiting-reply"];
  return STATES["up-to-date"];
}

function latestActivity(contact: Contact): number {
  return timestamp(contact.chat.at(-1)?.createdAt) || timestamp(contact.lastSyncedAt);
}

export function sortPinnedThenRecent(contacts: Contact[]): Contact[] {
  return [...contacts].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return latestActivity(right) - latestActivity(left);
  });
}
