import { MESSAGING_ROLES, PLAYBOOK_GOAL_MAX_CHARS, PLAYBOOK_RULES_MAX_CHARS, PLAYBOOK_VOICE_MAX_CHARS, createDefaultMessagingGuidance, createEmptyWorkspace, isMessagingRole, normalizeMessagingRole, normalizeWorkspaceModelId, type Contact, type ConversationAttachment, type Message, type PipelineStage, type RolePlaybooks, type WorkspaceData } from "./workspaceTypes";
import { PIPELINE_STAGES } from "./linkedinExtension";
import { repairLegacyLinkedInMessages } from "./messageDedup";
import { buildRulebookDigest } from "./rulebookDigest";

const DB_NAME = "chathelp-secure";
const DB_VERSION = 1;
const STORE_NAME = "vault";
const RECORD_KEY = "primary";
const DEVICE_KEY_RECORD = "device-key-v2";
const LEGACY_AAD = new TextEncoder().encode("ChatHelp vault v1");
const DEVICE_AAD = new TextEncoder().encode("ChatHelp device vault v2");
export const KDF_ITERATIONS = 600_000;

interface LegacyVaultEnvelope {
  format: "chathelp-encrypted-v1";
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string; ciphertext: string };
  updatedAt: string;
}

interface DeviceVaultEnvelope {
  format: "chathelp-device-v2";
  cipher: { name: "AES-GCM"; iv: string; ciphertext: string };
  updatedAt: string;
}

type StoredVaultEnvelope = LegacyVaultEnvelope | DeviceVaultEnvelope;
export type VaultMode = "empty" | "device" | "legacy-passphrase";

export interface VaultSession {
  key: CryptoKey;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser does not provide encrypted local storage."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      action();
    };
    const timer = globalThis.setTimeout(() => finish(() => reject(new Error("Secure browser storage did not respond. Close other ChatHelp tabs and retry."))), 8_000);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      finish(() => resolve(request.result));
    };
    request.onerror = () => finish(() => reject(request.error ?? new Error("Unable to open secure storage")));
    request.onblocked = () => finish(() => reject(new Error("Secure storage is blocked by another ChatHelp tab. Close other ChatHelp windows and retry.")));
  });
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Secure storage operation failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Secure storage transaction aborted"));
    });
  } finally {
    db.close();
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations = KDF_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function assertLegacyEnvelope(value: unknown): asserts value is LegacyVaultEnvelope {
  const item = value as Partial<LegacyVaultEnvelope> | null;
  if (!item || item.format !== "chathelp-encrypted-v1" || item.kdf?.name !== "PBKDF2" ||
      item.kdf.hash !== "SHA-256" || item.cipher?.name !== "AES-GCM" ||
      typeof item.kdf.salt !== "string" || typeof item.cipher.iv !== "string" ||
      typeof item.cipher.ciphertext !== "string" || !Number.isSafeInteger(item.kdf.iterations)) {
    throw new Error("This is not a valid ChatHelp encrypted backup.");
  }
}

function assertDeviceEnvelope(value: unknown): asserts value is DeviceVaultEnvelope {
  const item = value as Partial<DeviceVaultEnvelope> | null;
  if (!item || item.format !== "chathelp-device-v2" || item.cipher?.name !== "AES-GCM" ||
      typeof item.cipher.iv !== "string" || typeof item.cipher.ciphertext !== "string") {
    throw new Error("This browser's encrypted workspace is not valid.");
  }
}

async function encryptWorkspace(workspace: WorkspaceData, session: VaultSession): Promise<DeviceVaultEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(workspace));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: DEVICE_AAD as BufferSource },
    session.key,
    plaintext as BufferSource,
  );
  return {
    format: "chathelp-device-v2",
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) },
    updatedAt: new Date().toISOString(),
  };
}

async function decryptLegacyEnvelope(envelope: LegacyVaultEnvelope, passphrase: string): Promise<WorkspaceData> {
  const salt = base64ToBytes(envelope.kdf.salt);
  const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.cipher.iv) as BufferSource, additionalData: LEGACY_AAD as BufferSource },
      key,
      base64ToBytes(envelope.cipher.ciphertext) as BufferSource,
    );
    return normalizeWorkspace(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error("Incorrect passphrase or the encrypted vault has been changed.");
  }
}

async function decryptDeviceEnvelope(envelope: DeviceVaultEnvelope, key: CryptoKey): Promise<WorkspaceData> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.cipher.iv) as BufferSource, additionalData: DEVICE_AAD as BufferSource },
      key,
      base64ToBytes(envelope.cipher.ciphertext) as BufferSource,
    );
    return normalizeWorkspace(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error("This browser could not unlock its encrypted workspace. The local device key may have been removed or changed.");
  }
}

export async function getVaultMode(): Promise<VaultMode> {
  const envelope = await withStore<StoredVaultEnvelope | undefined>("readonly", (store) => store.get(RECORD_KEY));
  if (!envelope) return "empty";
  if (envelope.format === "chathelp-encrypted-v1") return "legacy-passphrase";
  assertDeviceEnvelope(envelope);
  return "device";
}

export async function createDeviceVault(workspace = createEmptyWorkspace()): Promise<{ workspace: WorkspaceData; session: VaultSession }> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const session = { key };
  const envelope = await encryptWorkspace(workspace, session);
  await withStore("readwrite", (store) => store.put(key, DEVICE_KEY_RECORD));
  await withStore("readwrite", (store) => store.put(envelope, RECORD_KEY));
  return { workspace, session };
}

export async function openDeviceVault(): Promise<{ workspace: WorkspaceData; session: VaultSession }> {
  const envelope = await withStore<StoredVaultEnvelope | undefined>("readonly", (store) => store.get(RECORD_KEY));
  if (!envelope) throw new Error("No encrypted workspace exists on this browser profile.");
  if (envelope.format === "chathelp-encrypted-v1") throw new Error("This workspace needs a one-time passphrase migration.");
  assertDeviceEnvelope(envelope);
  const key = await withStore<CryptoKey | undefined>("readonly", (store) => store.get(DEVICE_KEY_RECORD));
  if (!key) throw new Error("The encryption key for this browser is missing. Erase this device's vault to start again.");
  return { workspace: await decryptDeviceEnvelope(envelope, key), session: { key } };
}

export async function migrateLegacyVault(passphrase: string): Promise<{ workspace: WorkspaceData; session: VaultSession }> {
  const envelope = await withStore<StoredVaultEnvelope | undefined>("readonly", (store) => store.get(RECORD_KEY));
  assertLegacyEnvelope(envelope);
  const workspace = await decryptLegacyEnvelope(envelope, passphrase);
  return createDeviceVault(workspace);
}

export async function saveVault(workspace: WorkspaceData, session: VaultSession): Promise<void> {
  const envelope = await encryptWorkspace(normalizeWorkspace(workspace), session);
  await withStore("readwrite", (store) => store.put(envelope, RECORD_KEY));
}

export async function eraseVault(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(RECORD_KEY));
  await withStore("readwrite", (store) => store.delete(DEVICE_KEY_RECORD));
}

function normalizeMessage(value: Partial<Message>, index: number): Message {
  const attachments = Array.isArray(value.attachments) ? value.attachments.slice(0, 20).flatMap((attachment, attachmentIndex): ConversationAttachment[] => {
    if (!attachment || typeof attachment !== "object") return [];
    const item = attachment as Partial<ConversationAttachment>;
    const label = typeof item.label === "string" ? item.label.slice(0, 300) : "";
    if (!label) return [];
    const kind = item.kind === "file" || item.kind === "image" || item.kind === "link" ? item.kind : "unknown";
    return [{ id: typeof item.id === "string" ? item.id.slice(0, 200) : `attachment-${attachmentIndex}`, label, kind }];
  }) : [];
  return {
    id: typeof value.id === "string" ? value.id : "message-" + index,
    role: value.role === "them" ? "them" : "me",
    body: typeof value.body === "string" ? value.body.slice(0, 20_000) : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    speaker: typeof value.speaker === "string" ? value.speaker.slice(0, 200) : "",
    attachments,
  };
}

function normalizeStage(value: unknown): PipelineStage {
  return PIPELINE_STAGES.some((stage) => stage.value === value) ? value as PipelineStage : "inbox";
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((label): label is string => typeof label === "string").map((label) => label.trim().slice(0, 80)).filter(Boolean))).slice(0, 50);
}

function normalizeSyncDiagnostic(value: unknown): Contact["lastSyncDiagnostic"] {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.action !== "created" && item.action !== "updated" && item.action !== "no-change") return undefined;
  const count = (field: string) => typeof item[field] === "number" && Number.isFinite(item[field]) ? Math.max(0, Math.floor(item[field])) : 0;
  return {
    action: item.action,
    visibleMessages: count("visibleMessages"),
    importedMessages: count("importedMessages"),
    duplicateMessages: count("duplicateMessages"),
    restoredFromArchive: item.restoredFromArchive === true,
    snapshotFingerprint: typeof item.snapshotFingerprint === "string" ? item.snapshotFingerprint.slice(0, 100) : "",
    synchronizedAt: typeof item.synchronizedAt === "string" ? item.synchronizedAt.slice(0, 100) : "",
  };
}

export function normalizeWorkspace(value: unknown): WorkspaceData {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const contacts = Array.isArray(source.contacts) ? source.contacts : [];
  const cloudInference = source.cloudInference && typeof source.cloudInference === "object"
    ? source.cloudInference as Record<string, unknown>
    : {};
  const rememberAccessToken = cloudInference.rememberAccessToken === true;
  const rawGuidance = source.guidance && typeof source.guidance === "object" ? source.guidance as Record<string, unknown> : {};
  const selectedRole = normalizeMessagingRole(rawGuidance.selectedRole ?? rawGuidance.role);
  const defaults = createDefaultMessagingGuidance();
  const rawPlaybooks = rawGuidance.playbooks && typeof rawGuidance.playbooks === "object" ? rawGuidance.playbooks as Record<string, unknown> : null;
  const playbooks: RolePlaybooks = {
    "Human Resource": { ...defaults.playbooks["Human Resource"] },
    "Network Marketing": { ...defaults.playbooks["Network Marketing"] },
    "Job Seeker": { ...defaults.playbooks["Job Seeker"] },
    "Socializing/Networking": { ...defaults.playbooks["Socializing/Networking"] },
  };
  if (rawPlaybooks) {
    for (const role of MESSAGING_ROLES) {
      const rawPlaybook = rawPlaybooks[role] && typeof rawPlaybooks[role] === "object" ? rawPlaybooks[role] as Record<string, unknown> : {};
      playbooks[role] = {
        objective: typeof rawPlaybook.objective === "string" ? rawPlaybook.objective.slice(0, PLAYBOOK_GOAL_MAX_CHARS) : playbooks[role].objective,
        boundaries: typeof rawPlaybook.boundaries === "string" ? rawPlaybook.boundaries.slice(0, PLAYBOOK_RULES_MAX_CHARS) : playbooks[role].boundaries,
        rulebookDigest: "",
      };
      playbooks[role].rulebookDigest = buildRulebookDigest(playbooks[role].boundaries);
    }
  } else {
    playbooks[selectedRole] = {
      objective: typeof rawGuidance.objective === "string" ? rawGuidance.objective.slice(0, PLAYBOOK_GOAL_MAX_CHARS) : playbooks[selectedRole].objective,
      boundaries: typeof rawGuidance.boundaries === "string" ? rawGuidance.boundaries.slice(0, PLAYBOOK_RULES_MAX_CHARS) : playbooks[selectedRole].boundaries,
      rulebookDigest: "",
    };
    playbooks[selectedRole].rulebookDigest = buildRulebookDigest(playbooks[selectedRole].boundaries);
  }
  const guidance = {
    selectedRole,
    voice: typeof rawGuidance.voice === "string" ? rawGuidance.voice.slice(0, PLAYBOOK_VOICE_MAX_CHARS) : defaults.voice,
    playbooks,
  };
  const inboxRole = isMessagingRole(source.inboxRole) ? source.inboxRole : selectedRole;
  return {
    version: 8,
    modelId: normalizeWorkspaceModelId(),
    cloudInference: {
      accessToken: rememberAccessToken && typeof cloudInference.accessToken === "string" ? cloudInference.accessToken.slice(0, 200) : "",
      consentedAt: typeof cloudInference.consentedAt === "string" ? cloudInference.consentedAt.slice(0, 100) : "",
      rememberAccessToken,
    },
    guidance,
    inboxRole,
    contacts: contacts.slice(0, 100).map((raw, index): Contact => {
      const contact = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const captured = typeof contact.capturedContext === "string" ? contact.capturedContext : "";
      return {
        id: typeof contact.id === "string" ? contact.id : "contact-" + index,
        name: typeof contact.name === "string" ? contact.name.slice(0, 200) : "Unknown contact",
        headline: typeof contact.headline === "string" ? contact.headline.slice(0, 500) : "",
        profileNotes: typeof contact.profileNotes === "string" ? contact.profileNotes.slice(0, 20_000) : "",
        platform: contact.platform === "gmail" || contact.platform === "outlook" || contact.platform === "other" ? contact.platform : "linkedin",
        platformUrl: typeof contact.platformUrl === "string" ? contact.platformUrl.slice(0, 2000) : "",
        chat: Array.isArray(contact.chat) ? repairLegacyLinkedInMessages(contact.chat.slice(-1000).map((message, messageIndex) => normalizeMessage(message as Partial<Message>, messageIndex))) : [],
        documents: Array.isArray(contact.documents) ? contact.documents.slice(0, 50).map((document, documentIndex) => {
          const item = document as Record<string, unknown>;
          return { id: typeof item.id === "string" ? item.id : "document-" + documentIndex, name: typeof item.name === "string" ? item.name.slice(0, 200) : "Imported context", text: typeof item.text === "string" ? item.text.slice(0, 100_000) : "", createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString() };
        }) : captured ? [{ id: "legacy-capture", name: "Migrated screen capture", text: captured.slice(0, 100_000), createdAt: new Date().toISOString() }] : [],
        outcomes: Array.isArray(contact.outcomes) ? contact.outcomes.slice(-200).map((outcome, outcomeIndex) => {
          const item = outcome as Record<string, unknown>;
          const result = item.result === "positive" || item.result === "negative" ? item.result : "neutral";
          return { id: typeof item.id === "string" ? item.id : "outcome-" + outcomeIndex, result, note: typeof item.note === "string" ? item.note.slice(0, 2000) : "", createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString() };
        }) : [],
        retentionDays: contact.retentionDays === 0 || contact.retentionDays === 30 || contact.retentionDays === 365 ? contact.retentionDays : 90,
        profileUrl: typeof contact.profileUrl === "string" ? contact.profileUrl.slice(0, 2_000) : "",
        avatarUrl: typeof contact.avatarUrl === "string" ? contact.avatarUrl.slice(0, 2_000) : "",
        company: typeof contact.company === "string" ? contact.company.slice(0, 500) : "",
        conversationUrl: typeof contact.conversationUrl === "string" ? contact.conversationUrl.slice(0, 2_000) : "",
        source: contact.source === "linkedin-extension" ? "linkedin-extension" : "manual",
        labels: normalizeLabels(contact.labels),
        pipelineStage: normalizeStage(contact.pipelineStage),
        notes: typeof contact.notes === "string" ? contact.notes.slice(0, 20_000) : "",
        snoozedUntil: typeof contact.snoozedUntil === "string" ? contact.snoozedUntil.slice(0, 100) : "",
        followUpAt: typeof contact.followUpAt === "string" ? contact.followUpAt.slice(0, 100) : "",
        archivedAt: typeof contact.archivedAt === "string" ? contact.archivedAt.slice(0, 100) : "",
        firstSyncedAt: typeof contact.firstSyncedAt === "string" ? contact.firstSyncedAt.slice(0, 100) : "",
        lastSyncedAt: typeof contact.lastSyncedAt === "string" ? contact.lastSyncedAt.slice(0, 100) : "",
        lastSyncMessageCount: typeof contact.lastSyncMessageCount === "number" && Number.isFinite(contact.lastSyncMessageCount) ? Math.max(0, Math.floor(contact.lastSyncMessageCount)) : 0,
        pinned: contact.pinned === true,
        readLater: contact.readLater === true,
        lastSyncDiagnostic: normalizeSyncDiagnostic(contact.lastSyncDiagnostic),
        draftHistory: Array.isArray(contact.draftHistory) ? contact.draftHistory.slice(-20).flatMap((draft, draftIndex) => {
          if (!draft || typeof draft !== "object") return [];
          const item = draft as Record<string, unknown>;
          const drafts = Array.isArray(item.drafts) ? item.drafts.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 5_000)).slice(0, 3) : [];
          if (!drafts.length) return [];
          return [{ id: typeof item.id === "string" ? item.id.slice(0, 200) : `draft-history-${draftIndex}`, agenda: typeof item.agenda === "string" ? item.agenda.slice(0, 5_000) : "", drafts, createdAt: typeof item.createdAt === "string" ? item.createdAt.slice(0, 100) : new Date().toISOString(), role: isMessagingRole(item.role) ? item.role : inboxRole }];
        }) : [],
      };
    }),
    feedback: Array.isArray(source.feedback) ? source.feedback.slice(-1000) as WorkspaceData["feedback"] : [],
    aiUsage: Array.isArray(source.aiUsage) ? source.aiUsage.slice(-1000).flatMap((usage, usageIndex) => {
      if (!usage || typeof usage !== "object") return [];
      const item = usage as Record<string, unknown>;
      return [{
        id: typeof item.id === "string" ? item.id.slice(0, 200) : `usage-${usageIndex}`,
        contactId: typeof item.contactId === "string" ? item.contactId.slice(0, 200) : "",
        modelId: typeof item.modelId === "string" ? item.modelId.slice(0, 300) : normalizeWorkspaceModelId(),
        promptCharacters: typeof item.promptCharacters === "number" && Number.isFinite(item.promptCharacters) ? Math.max(0, Math.floor(item.promptCharacters)) : 0,
        variants: typeof item.variants === "number" && Number.isFinite(item.variants) ? Math.max(0, Math.floor(item.variants)) : 0,
        estimatedCostUsd: 0,
        createdAt: typeof item.createdAt === "string" ? item.createdAt.slice(0, 100) : new Date().toISOString(),
      }];
    }) : [],
  };
}

export function parseLegacyWorkspace(raw: string | null): WorkspaceData | null {
  if (!raw) return null;
  try { return normalizeWorkspace(JSON.parse(raw)); } catch { return null; }
}

export async function createLegacyVaultForTests(passphrase: string, workspace = createEmptyWorkspace()): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(workspace));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: LEGACY_AAD as BufferSource },
    key,
    plaintext as BufferSource,
  );
  const envelope: LegacyVaultEnvelope = {
    format: "chathelp-encrypted-v1",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: bytesToBase64(salt) },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) },
    updatedAt: new Date().toISOString(),
  };
  await withStore("readwrite", (store) => store.put(envelope, RECORD_KEY));
}

export async function readVaultEnvelopeForTests(): Promise<unknown> {
  return withStore("readonly", (store) => store.get(RECORD_KEY));
}

export async function writeVaultEnvelopeForTests(envelope: unknown): Promise<void> {
  await withStore("readwrite", (store) => store.put(envelope, RECORD_KEY));
}

export async function resetVaultForTests(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Vault database deletion was blocked"));
  });
}
