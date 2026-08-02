import type { Contact, ConversationAttachment, Message, PipelineStage } from "./workspaceTypes";

export const LINKEDIN_SNAPSHOT_EVENT = "CHATHELP_LINKEDIN_SNAPSHOT";
export const LINKEDIN_SNAPSHOT_REQUEST_EVENT = "CHATHELP_REQUEST_LINKEDIN_SNAPSHOT";
export const LINKEDIN_SNAPSHOT_ACK_EVENT = "CHATHELP_ACK_LINKEDIN_SNAPSHOT";
export const LINKEDIN_SELECTED_CONTACT_EVENT = "CHATHELP_SET_SELECTED_LINKEDIN_CONTACT";
export const LINKEDIN_EXTENSION_SOURCE = "chathelp-linkedin-extension";

export type LinkedInCaptureMethod = "detecting" | "extension" | "screen" | "manual";

export interface LinkedInCaptureCapabilities {
  detected: boolean;
  extensionConnected: boolean;
  isMobile: boolean;
  supportsScreenCapture: boolean;
}

export function isLikelyMobileDevice(userAgent: string, maxTouchPoints = 0): boolean {
  const agent = userAgent.toLowerCase();
  return /android|iphone|ipad|ipod|mobile/.test(agent) || (agent.includes("macintosh") && maxTouchPoints > 1);
}

export function recommendLinkedInCaptureMethod(capabilities: LinkedInCaptureCapabilities): LinkedInCaptureMethod {
  if (!capabilities.detected) return "detecting";
  if (!capabilities.isMobile) return "extension";
  return "manual";
}

export const PIPELINE_STAGES: ReadonlyArray<{ value: PipelineStage; label: string }> = [
  { value: "inbox", label: "Inbox" },
  { value: "hot", label: "Hot" },
  { value: "warm", label: "Warm" },
  { value: "cold", label: "Cold" },
  { value: "follow-up", label: "Follow-up" },
  { value: "replied", label: "Replied" },
  { value: "snoozed", label: "Snoozed" },
  { value: "done", label: "Done" },
];

export interface LinkedInExtensionSnapshot {
  source: typeof LINKEDIN_EXTENSION_SOURCE;
  version: 1;
  captureId: string;
  capturedAt: string;
  pageUrl: string;
  contact: {
    name: string;
    headline: string;
    profileUrl: string;
    avatarUrl: string;
  };
  messages: Array<{
    id: string;
    role: "me" | "them";
    speaker: string;
    body: string;
    createdAt: string;
    attachments: ConversationAttachment[];
  }>;
}

export interface LinkedInSelectedContact {
  contactId: string;
  name: string;
  profileUrl: string;
}

function boundedString(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function safeIsoDate(value: unknown, fallback = ""): string {
  const text = boundedString(value, 100);
  if (!text) return fallback;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function safeLinkedInUrl(value: unknown, kind: "profile" | "conversation"): string {
  const text = boundedString(value, 2_000);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || (url.hostname !== "linkedin.com" && url.hostname !== "www.linkedin.com")) return "";
    if (kind === "profile" && !url.pathname.startsWith("/in/")) return "";
    if (kind === "conversation" && !url.pathname.startsWith("/messaging/")) return "";
    url.hostname = "www.linkedin.com";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeAvatarUrl(value: unknown): string {
  const text = boundedString(value, 2_000);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || (url.hostname !== "linkedin.com" && !url.hostname.endsWith(".linkedin.com") && !url.hostname.endsWith(".licdn.com"))) return "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function attachmentKind(value: unknown): ConversationAttachment["kind"] {
  return value === "file" || value === "image" || value === "link" ? value : "unknown";
}

function parseAttachments(value: unknown): ConversationAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const label = boundedString(item.label, 300);
    if (!label) return [];
    return [{
      id: boundedString(item.id, 200) || `attachment-${index}`,
      label,
      kind: attachmentKind(item.kind),
    }];
  });
}

export function parseLinkedInExtensionSnapshot(value: unknown): LinkedInExtensionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.source !== LINKEDIN_EXTENSION_SOURCE || raw.version !== 1 || !raw.contact || typeof raw.contact !== "object") return null;
  const contact = raw.contact as Record<string, unknown>;
  const name = boundedString(contact.name, 200);
  const captureId = boundedString(raw.captureId, 200);
  const capturedAt = safeIsoDate(raw.capturedAt);
  if (!name || !captureId || !capturedAt || !Array.isArray(raw.messages)) return null;

  const messages = raw.messages.slice(0, 500).flatMap((message, index) => {
    if (!message || typeof message !== "object") return [];
    const item = message as Record<string, unknown>;
    const body = boundedString(item.body, 20_000);
    const attachments = parseAttachments(item.attachments);
    if (!body && !attachments.length) return [];
    return [{
      id: boundedString(item.id, 200) || `${captureId}-message-${index}`,
      role: item.role === "me" ? "me" as const : "them" as const,
      speaker: boundedString(item.speaker, 200),
      body,
      createdAt: safeIsoDate(item.createdAt),
      attachments,
    }];
  });
  if (!messages.length) return null;

  return {
    source: LINKEDIN_EXTENSION_SOURCE,
    version: 1,
    captureId,
    capturedAt,
    pageUrl: safeLinkedInUrl(raw.pageUrl, "conversation"),
    contact: {
      name,
      headline: boundedString(contact.headline, 500),
      profileUrl: safeLinkedInUrl(contact.profileUrl, "profile"),
      avatarUrl: safeAvatarUrl(contact.avatarUrl),
    },
    messages,
  };
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function messageFingerprint(message: Pick<Message, "role" | "body" | "createdAt">): string {
  return `${message.role}|${message.body.trim().replace(/\s+/g, " ").toLowerCase()}|${message.createdAt || "undated"}`;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function linkedInSelectionForContact(contact: Contact | null | undefined): LinkedInSelectedContact | null {
  if (!contact || contact.platform !== "linkedin" || !contact.id.trim() || !contact.name.trim()) return null;
  return {
    contactId: contact.id.slice(0, 200),
    name: contact.name.trim().slice(0, 200),
    profileUrl: safeLinkedInUrl(contact.profileUrl, "profile"),
  };
}

export function isLinkedInSnapshotForContact(contact: Contact, snapshot: LinkedInExtensionSnapshot): boolean {
  if (contact.platform !== "linkedin") return false;
  const selectedProfileUrl = safeLinkedInUrl(contact.profileUrl, "profile");
  if (selectedProfileUrl && snapshot.contact.profileUrl) return selectedProfileUrl === snapshot.contact.profileUrl;
  return normalizedName(contact.name) === normalizedName(snapshot.contact.name);
}

export function mergeLinkedInSnapshotForContact(
  contacts: Contact[],
  contactId: string,
  snapshot: LinkedInExtensionSnapshot,
): { contacts: Contact[]; contactId: string; importedMessages: number } | null {
  const existing = contacts.find((item) => item.id === contactId);
  if (!existing || !isLinkedInSnapshotForContact(existing, snapshot)) return null;
  const currentMessages = existing.chat;
  const knownIds = new Set(currentMessages.map((message) => message.id));
  const knownFingerprints = new Set(currentMessages.map(messageFingerprint));
  let importedMessages = 0;
  const imported: Message[] = [];

  snapshot.messages.forEach((message) => {
    const createdAt = message.createdAt || snapshot.capturedAt;
    const id = `linkedin-${hashText(`${message.id}|${message.role}|${message.body}|${message.createdAt}`)}`;
    const next: Message = {
      id,
      role: message.role,
      body: message.body,
      createdAt,
      speaker: message.speaker,
      attachments: message.attachments,
    };
    const fingerprint = messageFingerprint(next);
    if (knownIds.has(id) || knownFingerprints.has(fingerprint)) return;
    knownIds.add(id);
    knownFingerprints.add(fingerprint);
    imported.push(next);
    importedMessages += 1;
  });

  const nextContact: Contact = {
    ...existing,
    id: existing.id,
    name: existing.name,
    headline: snapshot.contact.headline || existing?.headline || "",
    platform: "linkedin",
    chat: [...currentMessages, ...imported].slice(-1000),
    profileUrl: snapshot.contact.profileUrl || existing.profileUrl || "",
    avatarUrl: snapshot.contact.avatarUrl || existing.avatarUrl || "",
    conversationUrl: snapshot.pageUrl || existing.conversationUrl || "",
    lastSyncedAt: snapshot.capturedAt,
  };

  return {
    contacts: contacts.map((item) => item.id === existing.id ? nextContact : item),
    contactId: existing.id,
    importedMessages,
  };
}

export function contactStage(contact: Contact): PipelineStage {
  return PIPELINE_STAGES.some((stage) => stage.value === contact.pipelineStage) ? contact.pipelineStage as PipelineStage : "inbox";
}

export function isActivelySnoozed(contact: Contact, now = Date.now()): boolean {
  const snoozed = contact.snoozedUntil ? new Date(contact.snoozedUntil).getTime() : 0;
  return Number.isFinite(snoozed) && snoozed > now;
}

export function isReminderDue(contact: Contact, now = Date.now()): boolean {
  const followUp = contact.followUpAt ? new Date(contact.followUpAt).getTime() : 0;
  const snoozed = contact.snoozedUntil ? new Date(contact.snoozedUntil).getTime() : 0;
  return (Number.isFinite(followUp) && followUp > 0 && followUp <= now) || (Number.isFinite(snoozed) && snoozed > 0 && snoozed <= now);
}
