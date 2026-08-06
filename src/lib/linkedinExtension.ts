import type { Contact, ConversationAttachment, Message, PipelineStage } from "./workspaceTypes";
import { isLegacyLinkedInMessageId, linkedInMessageContentKey, repairLegacyLinkedInMessages } from "./messageDedup";

export const LINKEDIN_SNAPSHOT_EVENT = "CHATHELP_LINKEDIN_SNAPSHOT";
export const LINKEDIN_SNAPSHOT_REQUEST_EVENT = "CHATHELP_REQUEST_LINKEDIN_SNAPSHOT";
export const LINKEDIN_SNAPSHOT_ACK_EVENT = "CHATHELP_ACK_LINKEDIN_SNAPSHOT";
export const LINKEDIN_EXTENSION_STATUS_EVENT = "CHATHELP_LINKEDIN_EXTENSION_STATUS";
export const LINKEDIN_EXTENSION_STATUS_ACK_EVENT = "CHATHELP_ACK_LINKEDIN_EXTENSION_STATUS";
export const LINKEDIN_SYNC_COMMAND_EVENT = "CHATHELP_LINKEDIN_SYNC_COMMAND";
export const LINKEDIN_SYNC_STATE_EVENT = "CHATHELP_LINKEDIN_SYNC_STATE";
export const LINKEDIN_EXTENSION_SOURCE = "chathelp-linkedin-extension";
export const REQUIRED_LINKEDIN_EXTENSION_VERSION = "0.5.0";

export type LinkedInCaptureMethod = "detecting" | "extension" | "screen" | "manual";
export type LinkedInSyncCommand = "enable" | "pause" | "resume" | "disable" | "refresh";

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
  version: 2;
  captureMode: "automatic" | "manual";
  captureId: string;
  capturedAt: string;
  pageUrl: string;
  contact: {
    name: string;
    headline: string;
    company: string;
    profileUrl: string;
    avatarUrl: string;
  };
  messages: Array<{
    id: string;
    sourceId: string;
    role: "me" | "them";
    speaker: string;
    body: string;
    createdAt: string;
    attachments: ConversationAttachment[];
  }>;
}

export interface LinkedInExtensionStatus {
  source: typeof LINKEDIN_EXTENSION_SOURCE;
  version: 2;
  statusId: string;
  occurredAt: string;
  kind: "success" | "error" | "info";
  code: string;
  message: string;
  observedContact: {
    name: string;
    profileUrl: string;
  } | null;
}

export interface LinkedInSyncState {
  source: typeof LINKEDIN_EXTENSION_SOURCE;
  version: 1;
  stateId: string;
  occurredAt: string;
  enabled: boolean;
  paused: boolean;
  permissionGranted: boolean;
  code: string;
  message: string;
  lastContactName: string;
  lastMessageCount: number;
}

export interface LinkedInSnapshotUpsertResult {
  contacts: Contact[];
  contactId: string;
  importedMessages: number;
  duplicateMessages: number;
  restoredFromArchive: boolean;
  snapshotFingerprint: string;
  action: "created" | "updated" | "no-change" | "ambiguous";
  matchedBy: "profile" | "conversation" | "name" | "new" | "ambiguous";
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
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeLinkedInProfileUrl(value: unknown): string {
  return safeLinkedInUrl(value, "profile");
}

export function normalizeLinkedInConversationUrl(value: unknown): string {
  return safeLinkedInUrl(value, "conversation");
}

export function isCurrentLinkedInExtensionVersion(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parse = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10));
  const current = parse(value);
  const required = parse(REQUIRED_LINKEDIN_EXTENSION_VERSION);
  if (current.length !== 3 || current.some((part) => !Number.isInteger(part) || part < 0)) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > required[index]) return true;
    if (current[index] < required[index]) return false;
  }
  return true;
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
    return [{ id: boundedString(item.id, 200) || `attachment-${index}`, label, kind: attachmentKind(item.kind) }];
  });
}

export function parseLinkedInExtensionStatus(value: unknown): LinkedInExtensionStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.source !== LINKEDIN_EXTENSION_SOURCE || (raw.version !== 1 && raw.version !== 2)) return null;
  const statusId = boundedString(raw.statusId, 200);
  const occurredAt = safeIsoDate(raw.occurredAt);
  const kind = raw.kind === "success" ? "success" : raw.kind === "error" ? "error" : raw.kind === "info" ? "info" : null;
  const code = boundedString(raw.code, 100);
  const message = boundedString(raw.message, 1_000);
  if (!statusId || !occurredAt || !kind || !code || !message) return null;
  let observedContact: LinkedInExtensionStatus["observedContact"] = null;
  if (raw.observedContact && typeof raw.observedContact === "object") {
    const observed = raw.observedContact as Record<string, unknown>;
    const name = boundedString(observed.name, 200);
    if (name) observedContact = { name, profileUrl: safeLinkedInUrl(observed.profileUrl, "profile") };
  }
  return { source: LINKEDIN_EXTENSION_SOURCE, version: 2, statusId, occurredAt, kind, code, message, observedContact };
}

export function parseLinkedInSyncState(value: unknown): LinkedInSyncState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.source !== LINKEDIN_EXTENSION_SOURCE || raw.version !== 1) return null;
  const stateId = boundedString(raw.stateId, 200);
  const occurredAt = safeIsoDate(raw.occurredAt);
  const code = boundedString(raw.code, 100);
  const message = boundedString(raw.message, 1_000);
  if (!stateId || !occurredAt || !code || !message) return null;
  return {
    source: LINKEDIN_EXTENSION_SOURCE,
    version: 1,
    stateId,
    occurredAt,
    enabled: raw.enabled === true,
    paused: raw.paused === true,
    permissionGranted: raw.permissionGranted === true,
    code,
    message,
    lastContactName: boundedString(raw.lastContactName, 200),
    lastMessageCount: typeof raw.lastMessageCount === "number" && Number.isFinite(raw.lastMessageCount) ? Math.max(0, Math.floor(raw.lastMessageCount)) : 0,
  };
}

export function parseLinkedInExtensionSnapshot(value: unknown): LinkedInExtensionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.source !== LINKEDIN_EXTENSION_SOURCE || (raw.version !== 1 && raw.version !== 2) || !raw.contact || typeof raw.contact !== "object") return null;
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
    const id = boundedString(item.id, 200) || `${captureId}-message-${index}`;
    return [{
      id,
      sourceId: boundedString(item.sourceId, 200) || (raw.version === 1 ? id : ""),
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
    version: 2,
    captureMode: raw.captureMode === "automatic" ? "automatic" : "manual",
    captureId,
    capturedAt,
    pageUrl: safeLinkedInUrl(raw.pageUrl, "conversation"),
    contact: {
      name,
      headline: boundedString(contact.headline, 500),
      company: boundedString(contact.company, 500),
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

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").normalize("NFKC").toLocaleLowerCase();
}

function normalizedName(value: string): string {
  return normalizedText(value);
}

function messageFingerprint(identity: string, message: Pick<Message, "role" | "body" | "createdAt" | "speaker" | "attachments">): string {
  const attachmentLabels = (message.attachments ?? []).map((attachment) => normalizedText(attachment.label)).join("|");
  return [identity, message.role, normalizedText(message.speaker ?? ""), normalizedText(message.body), message.createdAt || "undated", attachmentLabels].join("|");
}

function snapshotIdentity(snapshot: LinkedInExtensionSnapshot): string {
  return snapshot.contact.profileUrl || snapshot.pageUrl || normalizedName(snapshot.contact.name);
}

function safeSnapshotFingerprint(snapshot: LinkedInExtensionSnapshot): string {
  const messageMetadata = snapshot.messages.map((message) => [
    message.sourceId || message.id,
    message.role,
    message.createdAt || "undated",
    message.attachments.map((attachment) => normalizedText(attachment.label)).join("|"),
  ].join("|")).join("||");
  return hashText(`${snapshotIdentity(snapshot)}||${messageMetadata}`);
}

function newContactId(snapshot: LinkedInExtensionSnapshot): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${hashText(snapshot.captureId)}`;
  return `contact-${suffix}`;
}

function emptyLinkedInContact(snapshot: LinkedInExtensionSnapshot): Contact {
  return {
    id: newContactId(snapshot),
    name: snapshot.contact.name,
    headline: snapshot.contact.headline,
    company: snapshot.contact.company,
    profileNotes: "",
    platform: "linkedin",
    platformUrl: "",
    chat: [],
    documents: [],
    outcomes: [],
    retentionDays: 90,
    profileUrl: snapshot.contact.profileUrl,
    avatarUrl: snapshot.contact.avatarUrl,
    conversationUrl: snapshot.pageUrl,
    source: "linkedin-extension",
    labels: [],
    pipelineStage: "inbox",
    notes: "",
    snoozedUntil: "",
    followUpAt: "",
    archivedAt: "",
    firstSyncedAt: snapshot.capturedAt,
    lastSyncedAt: snapshot.capturedAt,
    lastSyncMessageCount: 0,
    draftHistory: [],
  };
}

function mergeMessages(contact: Contact, snapshot: LinkedInExtensionSnapshot): { contact: Contact; importedMessages: number; duplicateMessages: number; hasNewIncoming: boolean } {
  const identity = snapshotIdentity(snapshot);
  const repairedChat = repairLegacyLinkedInMessages(contact.chat);
  const knownIds = new Set(repairedChat.map((message) => message.id));
  const knownFingerprints = new Set(repairedChat.map((message) => messageFingerprint(identity, message)));
  const imported: Message[] = [];
  let duplicateMessages = 0;
  for (const message of snapshot.messages) {
    const createdAt = message.createdAt || snapshot.capturedAt;
    const visibleTimestamp = message.createdAt || "undated";
    const extractorFingerprintId = /^visible-message-[a-z0-9]+$/i.test(message.id) ? message.id : "";
    const fallbackIdentity = extractorFingerprintId || `${message.role}|${message.speaker}|${message.body}|${visibleTimestamp}|${message.attachments.map((item) => item.label).join("|")}`;
    const next: Message = {
      id: message.sourceId
        ? `linkedin-source-${hashText(`${identity}|source|${message.sourceId}`)}`
        : `linkedin-fallback-${hashText(`${identity}|fallback|${fallbackIdentity}`)}`,
      role: message.role,
      body: message.body,
      createdAt,
      speaker: message.speaker,
      attachments: message.attachments,
    };
    const fingerprint = messageFingerprint(identity, next);
    if (knownIds.has(next.id) || (!extractorFingerprintId && knownFingerprints.has(fingerprint))) {
      duplicateMessages += 1;
      continue;
    }
    const legacyMatchIndex = repairedChat.findIndex((existingMessage) => isLegacyLinkedInMessageId(existingMessage.id) && linkedInMessageContentKey(existingMessage) === linkedInMessageContentKey(next));
    if (legacyMatchIndex >= 0) {
      repairedChat[legacyMatchIndex] = { ...repairedChat[legacyMatchIndex], id: next.id };
      knownIds.add(next.id);
      duplicateMessages += 1;
      continue;
    }
    knownIds.add(next.id);
    knownFingerprints.add(fingerprint);
    imported.push(next);
  }
  return {
    importedMessages: imported.length,
    duplicateMessages,
    hasNewIncoming: imported.some((message) => message.role === "them"),
    contact: {
      ...contact,
      name: snapshot.contact.name || contact.name,
      headline: snapshot.contact.headline || contact.headline,
      company: snapshot.contact.company || contact.company || "",
      platform: "linkedin",
      chat: [...repairedChat, ...imported].slice(-1000),
      profileUrl: snapshot.contact.profileUrl || contact.profileUrl || "",
      avatarUrl: snapshot.contact.avatarUrl || contact.avatarUrl || "",
      conversationUrl: snapshot.pageUrl || contact.conversationUrl || "",
      source: contact.source ?? "manual",
      firstSyncedAt: contact.firstSyncedAt || snapshot.capturedAt,
      lastSyncedAt: snapshot.capturedAt,
      lastSyncMessageCount: snapshot.messages.length,
    },
  };
}

export function upsertLinkedInSnapshot(contacts: Contact[], snapshot: LinkedInExtensionSnapshot): LinkedInSnapshotUpsertResult {
  const snapshotFingerprint = safeSnapshotFingerprint(snapshot);
  const linkedInContacts = contacts.filter((contact) => contact.platform === "linkedin");
  const profileMatches = snapshot.contact.profileUrl
    ? linkedInContacts.filter((contact) => normalizeLinkedInProfileUrl(contact.profileUrl) === snapshot.contact.profileUrl)
    : [];
  if (profileMatches.length > 1) return { contacts, contactId: "", importedMessages: 0, duplicateMessages: 0, restoredFromArchive: false, snapshotFingerprint, action: "ambiguous", matchedBy: "ambiguous" };

  let existing = profileMatches[0];
  let matchedBy: LinkedInSnapshotUpsertResult["matchedBy"] = existing ? "profile" : "new";
  if (!existing && snapshot.pageUrl) {
    const conversationMatches = linkedInContacts.filter((contact) => normalizeLinkedInConversationUrl(contact.conversationUrl) === snapshot.pageUrl);
    if (conversationMatches.length > 1) return { contacts, contactId: "", importedMessages: 0, duplicateMessages: 0, restoredFromArchive: false, snapshotFingerprint, action: "ambiguous", matchedBy: "ambiguous" };
    existing = conversationMatches[0];
    if (existing) matchedBy = "conversation";
  }

  if (!existing) {
    const nameMatches = linkedInContacts.filter((contact) => {
      if (normalizedName(contact.name) !== normalizedName(snapshot.contact.name)) return false;
      const existingProfile = normalizeLinkedInProfileUrl(contact.profileUrl);
      const existingConversation = normalizeLinkedInConversationUrl(contact.conversationUrl);
      if (snapshot.contact.profileUrl && existingProfile && snapshot.contact.profileUrl !== existingProfile) return false;
      if (snapshot.pageUrl && existingConversation && snapshot.pageUrl !== existingConversation) return false;
      return true;
    });
    if (nameMatches.length === 1) {
      existing = nameMatches[0];
      matchedBy = "name";
    } else if (nameMatches.length > 1 && !snapshot.contact.profileUrl && !snapshot.pageUrl) {
      return { contacts, contactId: "", importedMessages: 0, duplicateMessages: 0, restoredFromArchive: false, snapshotFingerprint, action: "ambiguous", matchedBy: "ambiguous" };
    }
  }

  if (!existing) {
    const created = emptyLinkedInContact(snapshot);
    const merged = mergeMessages(created, snapshot);
    const diagnostic = {
      action: "created" as const,
      visibleMessages: snapshot.messages.length,
      importedMessages: merged.importedMessages,
      duplicateMessages: merged.duplicateMessages,
      restoredFromArchive: false,
      snapshotFingerprint,
      synchronizedAt: snapshot.capturedAt,
    };
    return {
      contacts: [...contacts, { ...merged.contact, source: "linkedin-extension", lastSyncDiagnostic: diagnostic }],
      contactId: created.id,
      importedMessages: merged.importedMessages,
      duplicateMessages: merged.duplicateMessages,
      restoredFromArchive: false,
      snapshotFingerprint,
      action: "created",
      matchedBy: "new",
    };
  }

  const merged = mergeMessages(existing, snapshot);
  const action = merged.importedMessages ? "updated" as const : "no-change" as const;
  const restoredFromArchive = Boolean(existing.archivedAt && merged.hasNewIncoming);
  const mergedContact: Contact = {
    ...merged.contact,
    ...(restoredFromArchive ? { archivedAt: "", pipelineStage: "inbox" as const } : {}),
    lastSyncDiagnostic: {
      action,
      visibleMessages: snapshot.messages.length,
      importedMessages: merged.importedMessages,
      duplicateMessages: merged.duplicateMessages,
      restoredFromArchive,
      snapshotFingerprint,
      synchronizedAt: snapshot.capturedAt,
    },
  };
  return {
    contacts: contacts.map((contact) => contact.id === existing?.id ? mergedContact : contact),
    contactId: existing.id,
    importedMessages: merged.importedMessages,
    duplicateMessages: merged.duplicateMessages,
    restoredFromArchive,
    snapshotFingerprint,
    action,
    matchedBy,
  };
}

export function isLinkedInSnapshotForContact(contact: Contact, snapshot: LinkedInExtensionSnapshot): boolean {
  if (contact.platform !== "linkedin") return false;
  const profileUrl = normalizeLinkedInProfileUrl(contact.profileUrl);
  if (profileUrl && snapshot.contact.profileUrl) return profileUrl === snapshot.contact.profileUrl;
  const conversationUrl = normalizeLinkedInConversationUrl(contact.conversationUrl);
  if (conversationUrl && snapshot.pageUrl) return conversationUrl === snapshot.pageUrl;
  return normalizedName(contact.name) === normalizedName(snapshot.contact.name);
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
