import { normalizeLinkedInConversationUrl, normalizeLinkedInProfileUrl } from "./linkedinExtension";
import { normalizeWorkspace } from "./secureVault";
import { createDefaultMessagingGuidance, type Contact, type Message, type WorkspaceData } from "./workspaceTypes";

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").normalize("NFKC").toLocaleLowerCase();
}

function normalizedName(contact: Contact): string {
  return normalizedText(contact.name);
}

function stableIdentityValues(contact: Contact): string[] {
  const profile = normalizeLinkedInProfileUrl(contact.profileUrl);
  const conversation = normalizeLinkedInConversationUrl(contact.conversationUrl);
  return [profile ? `profile:${profile}` : "", conversation ? `conversation:${conversation}` : ""].filter(Boolean);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function identityHashes(contact: Contact): Promise<string[]> {
  return Promise.all(stableIdentityValues(contact).map(sha256Hex));
}

function messageFingerprint(message: Message): string {
  const attachments = (message.attachments ?? []).map((attachment) => `${attachment.kind}:${normalizedText(attachment.label)}`).join("|");
  return [message.role, normalizedText(message.speaker ?? ""), normalizedText(message.body), message.createdAt, attachments].join("|");
}

function mergeMessages(local: Message[], remote: Message[]): Message[] {
  const result = [...local];
  const ids = new Set(local.map((message) => message.id));
  const fingerprints = new Set(local.map(messageFingerprint));
  for (const message of remote) {
    const fingerprint = messageFingerprint(message);
    if (ids.has(message.id) || fingerprints.has(fingerprint)) continue;
    result.push(message);
    ids.add(message.id);
    fingerprints.add(fingerprint);
  }
  return result.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function mergeById<T extends { id: string }>(local: T[] = [], remote: T[] = []): T[] {
  const result = [...local];
  const ids = new Set(local.map((item) => item.id));
  for (const item of remote) {
    if (!ids.has(item.id)) {
      result.push(item);
      ids.add(item.id);
    }
  }
  return result;
}

function laterRemote(local: Contact, remote: Contact): boolean {
  const localTime = Date.parse(local.lastSyncedAt ?? "");
  const remoteTime = Date.parse(remote.lastSyncedAt ?? "");
  return Number.isFinite(remoteTime) && (!Number.isFinite(localTime) || remoteTime > localTime);
}

function nonblank(preferred: string | undefined, fallback: string | undefined): string {
  return preferred?.trim() ? preferred : fallback ?? "";
}

function mergeContact(local: Contact, remote: Contact): Contact {
  const remotePreferred = laterRemote(local, remote);
  const preferred = remotePreferred ? remote : local;
  const fallback = remotePreferred ? local : remote;
  return {
    ...fallback,
    ...preferred,
    id: local.id,
    name: nonblank(preferred.name, fallback.name),
    headline: nonblank(preferred.headline, fallback.headline),
    profileNotes: nonblank(preferred.profileNotes, fallback.profileNotes),
    platformUrl: nonblank(preferred.platformUrl, fallback.platformUrl),
    profileUrl: nonblank(preferred.profileUrl, fallback.profileUrl),
    avatarUrl: nonblank(preferred.avatarUrl, fallback.avatarUrl),
    company: nonblank(preferred.company, fallback.company),
    conversationUrl: nonblank(preferred.conversationUrl, fallback.conversationUrl),
    notes: nonblank(preferred.notes, fallback.notes),
    followUpAt: nonblank(preferred.followUpAt, fallback.followUpAt),
    snoozedUntil: nonblank(preferred.snoozedUntil, fallback.snoozedUntil),
    archivedAt: nonblank(preferred.archivedAt, fallback.archivedAt),
    firstSyncedAt: nonblank(local.firstSyncedAt, remote.firstSyncedAt),
    lastSyncedAt: nonblank(preferred.lastSyncedAt, fallback.lastSyncedAt),
    labels: Array.from(new Set([...(local.labels ?? []), ...(remote.labels ?? [])])),
    chat: mergeMessages(local.chat, remote.chat),
    documents: mergeById(local.documents, remote.documents),
    outcomes: mergeById(local.outcomes, remote.outcomes),
    draftHistory: mergeById(local.draftHistory ?? [], remote.draftHistory ?? []),
  };
}

function mergeGuidance(local: WorkspaceData["guidance"], remote: WorkspaceData["guidance"]): WorkspaceData["guidance"] {
  const defaults = createDefaultMessagingGuidance();
  const playbooks = { ...local.playbooks };
  for (const role of Object.keys(playbooks) as Array<keyof typeof playbooks>) {
    const localBook = local.playbooks[role];
    const remoteBook = remote.playbooks[role];
    const objective = !localBook.objective.trim() || localBook.objective === defaults.playbooks[role].objective ? remoteBook.objective : localBook.objective;
    const boundaries = !localBook.boundaries.trim() || localBook.boundaries === defaults.playbooks[role].boundaries ? remoteBook.boundaries : localBook.boundaries;
    playbooks[role] = {
      objective: objective || defaults.playbooks[role].objective,
      boundaries: boundaries || defaults.playbooks[role].boundaries,
      rulebookDigest: boundaries === remoteBook.boundaries ? remoteBook.rulebookDigest : localBook.rulebookDigest,
    };
  }
  return {
    selectedRole: local.selectedRole,
    voice: local.voice.trim() && local.voice !== defaults.voice ? local.voice : remote.voice || defaults.voice,
    playbooks,
  };
}

async function tombstoned(contact: Contact, tombstones: WorkspaceData["deletionTombstones"]): Promise<boolean> {
  if (tombstones.some((tombstone) => tombstone.contactId === contact.id)) return true;
  const hashes = await identityHashes(contact);
  return hashes.some((hash) => tombstones.some((tombstone) => tombstone.identityHashes.includes(hash)));
}

export async function mergeCloudWorkspaces(localValue: WorkspaceData, remoteValue: WorkspaceData): Promise<WorkspaceData> {
  const local = normalizeWorkspace(localValue);
  const remote = normalizeWorkspace(remoteValue);
  const tombstones = [...local.deletionTombstones];
  const tombstoneKeys = new Set(tombstones.map((item) => `${item.contactId}|${item.deletedAt}`));
  for (const item of remote.deletionTombstones) {
    const key = `${item.contactId}|${item.deletedAt}`;
    if (!tombstoneKeys.has(key)) {
      tombstones.push(item);
      tombstoneKeys.add(key);
    }
  }

  const activeLocal: Contact[] = [];
  for (const item of local.contacts) if (!await tombstoned(item, tombstones)) activeLocal.push(item);
  const activeRemote: Contact[] = [];
  for (const item of remote.contacts) if (!await tombstoned(item, tombstones)) activeRemote.push(item);

  const merged = [...activeLocal];
  const remoteToLocal = new Map<string, string>();
  const localNameCounts = new Map<string, number>();
  const remoteNameCounts = new Map<string, number>();
  for (const item of activeLocal) localNameCounts.set(normalizedName(item), (localNameCounts.get(normalizedName(item)) ?? 0) + 1);
  for (const item of activeRemote) remoteNameCounts.set(normalizedName(item), (remoteNameCounts.get(normalizedName(item)) ?? 0) + 1);

  for (const remoteContact of activeRemote) {
    let matchIndex = merged.findIndex((item) => item.id === remoteContact.id);
    const remoteProfile = normalizeLinkedInProfileUrl(remoteContact.profileUrl);
    const remoteConversation = normalizeLinkedInConversationUrl(remoteContact.conversationUrl);
    if (matchIndex < 0 && remoteProfile) {
      const matches = merged.map((item, index) => ({ item, index })).filter(({ item }) => normalizeLinkedInProfileUrl(item.profileUrl) === remoteProfile);
      if (matches.length === 1) matchIndex = matches[0].index;
    }
    if (matchIndex < 0 && remoteConversation) {
      const matches = merged.map((item, index) => ({ item, index })).filter(({ item }) => normalizeLinkedInConversationUrl(item.conversationUrl) === remoteConversation);
      if (matches.length === 1) matchIndex = matches[0].index;
    }
    if (matchIndex < 0 && !remoteProfile && !remoteConversation) {
      const name = normalizedName(remoteContact);
      if (name && localNameCounts.get(name) === 1 && remoteNameCounts.get(name) === 1) {
        const candidate = merged.findIndex((item) => normalizedName(item) === name && !normalizeLinkedInProfileUrl(item.profileUrl) && !normalizeLinkedInConversationUrl(item.conversationUrl));
        if (candidate >= 0) matchIndex = candidate;
      }
    }
    if (matchIndex >= 0) {
      const localId = merged[matchIndex].id;
      merged[matchIndex] = mergeContact(merged[matchIndex], remoteContact);
      remoteToLocal.set(remoteContact.id, localId);
    } else {
      merged.push(remoteContact);
      remoteToLocal.set(remoteContact.id, remoteContact.id);
    }
  }

  const remappedFeedback = remote.feedback.map((item) => ({ ...item, contactId: remoteToLocal.get(item.contactId) ?? item.contactId }));
  const remappedUsage = remote.aiUsage.map((item) => ({ ...item, contactId: remoteToLocal.get(item.contactId) ?? item.contactId }));
  return normalizeWorkspace({
    ...local,
    contacts: merged,
    guidance: mergeGuidance(local.guidance, remote.guidance),
    feedback: mergeById(local.feedback, remappedFeedback),
    aiUsage: mergeById(local.aiUsage, remappedUsage),
    deletionTombstones: tombstones,
  });
}

export async function deleteContactEverywhere(workspaceValue: WorkspaceData, contactId: string, now = new Date().toISOString()): Promise<WorkspaceData> {
  const workspace = normalizeWorkspace(workspaceValue);
  const contact = workspace.contacts.find((item) => item.id === contactId);
  if (!contact) return workspace;
  const tombstone = { contactId, identityHashes: await identityHashes(contact), deletedAt: now };
  return normalizeWorkspace({
    ...workspace,
    contacts: workspace.contacts.filter((item) => item.id !== contactId),
    feedback: workspace.feedback.filter((item) => item.contactId !== contactId),
    aiUsage: workspace.aiUsage.filter((item) => item.contactId !== contactId),
    deletionTombstones: [...workspace.deletionTombstones, tombstone],
  });
}
