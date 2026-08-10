import { CONVERSATION_GOAL_MAX_CHARS, MESSAGING_ROLES, PLAYBOOK_GOAL_MAX_CHARS, PLAYBOOK_RULES_MAX_CHARS, PLAYBOOK_VOICE_MAX_CHARS, createDefaultMessagingGuidance, createEmptyWorkspace, isMessagingRole, normalizeMessagingRole, normalizePersonalGuidelines, normalizeRelationshipStage, normalizeWorkspaceModelId, type CloudLearningDeletionMarker, type CloudLearningSyncEntry, type Contact, type ConversationAttachment, type DraftLearningDecision, type DraftLearningDecisionPayload, type Message, type PendingLearningRecord, type PipelineStage, type RolePlaybooks, type WorkspaceData } from "./workspaceTypes";
import { PIPELINE_STAGES } from "./linkedinExtension";
import { repairLegacyLinkedInMessages } from "./messageDedup";
import { buildRulebookDigest } from "./rulebookDigest";
import { normalizeFeedback } from "./personalLearning";
import { normalizeStageTrainingRecord } from "./relationshipStageClassifier";
import { applyLearningRetention, LEARNING_RETENTION_DAYS } from "./retention";

const DB_NAME = "chathelp-secure";
const DB_VERSION = 1;
const STORE_NAME = "vault";
const RECORD_KEY = "primary";
const DEVICE_KEY_RECORD = "device-key-v2";
const CLOUD_RECOVERY_KEY_RECORD = "cloud-recovery-key-v1";
const LEGACY_AAD = new TextEncoder().encode("ChatHelp vault v1");
const DEVICE_AAD = new TextEncoder().encode("ChatHelp device vault v2");
export const KDF_ITERATIONS = 600_000;
const MAX_PENDING_LEARNING_RECORDS = 1_000;
const MAX_CLOUD_LEARNING_SYNC_ENTRIES = 1_000;
const MAX_CLOUD_LEARNING_DELETION_MARKERS = 1_000;

const GOAL_CATEGORY_BY_STAGE = {
  new_connection: "connect",
  genuine_rapport: "build_rapport",
  learn_interests: "discover_interests",
  identify_need: "identify_need",
  ask_permission: "request_permission",
  introduce_value: "present_value",
  answer_without_pressure: "answer_questions",
  voluntary_next_step: "agree_next_step",
} as const;

const ROLE_ID_BY_MESSAGING_ROLE = {
  "Human Resource": "human_resource",
  "Network Marketing": "network_marketing",
  "Job Seeker": "job_seeker",
  "Socializing/Networking": "socializing_networking",
} as const;

const ROLE_IDS = new Set<string>(Object.values(ROLE_ID_BY_MESSAGING_ROLE));

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
    const timer = globalThis.setTimeout(() => finish(() => reject(new Error("Secure browser storage did not respond. Close other DialogMint tabs and retry."))), 8_000);

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
    request.onblocked = () => finish(() => reject(new Error("Secure storage is blocked by another DialogMint tab. Close other DialogMint windows and retry.")));
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
    throw new Error("This is not a valid DialogMint encrypted backup.");
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
  const plaintext = new TextEncoder().encode(JSON.stringify(applyLearningRetention(normalizeWorkspace(workspace))));
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

export async function saveCloudRecoveryKey(key: CryptoKey): Promise<void> {
  if (key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM") {
    throw new Error("DialogMint recovery requires a non-extractable AES key.");
  }
  await withStore("readwrite", (store) => store.put(key, CLOUD_RECOVERY_KEY_RECORD));
}

export async function openCloudRecoveryKey(): Promise<CryptoKey | null> {
  const key = await withStore<CryptoKey | undefined>("readonly", (store) => store.get(CLOUD_RECOVERY_KEY_RECORD));
  if (!key) return null;
  if (key.type !== "secret" || key.extractable || key.algorithm.name !== "AES-GCM") {
    throw new Error("This browser's DialogMint recovery key is not valid.");
  }
  return key;
}

export async function removeCloudRecoveryKey(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(CLOUD_RECOVERY_KEY_RECORD));
}

export async function eraseVault(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(RECORD_KEY));
  await withStore("readwrite", (store) => store.delete(DEVICE_KEY_RECORD));
  await withStore("readwrite", (store) => store.delete(CLOUD_RECOVERY_KEY_RECORD));
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

function normalizedLearningTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value.slice(0, 100) : fallback;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizedClassifierPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!hasExactKeys(payload, ["recordKind", "roleId", "relationshipStage", "goalCategory", "provenance", "classifierFeatures"])
      || payload.recordKind !== "classifier" || payload.provenance !== "human_confirmed"
      || typeof payload.roleId !== "string" || typeof payload.relationshipStage !== "string" || typeof payload.goalCategory !== "string"
      || !ROLE_IDS.has(payload.roleId)
      || !Object.hasOwn(GOAL_CATEGORY_BY_STAGE, payload.relationshipStage)
      || GOAL_CATEGORY_BY_STAGE[payload.relationshipStage as keyof typeof GOAL_CATEGORY_BY_STAGE] !== payload.goalCategory
      || !payload.classifierFeatures || typeof payload.classifierFeatures !== "object" || Array.isArray(payload.classifierFeatures)) return null;
  const features = payload.classifierFeatures as Record<string, unknown>;
  const featureKeys = ["messageCountBucket", "hasIncomingQuestion", "hasNeedSignal", "hasPermissionSignal", "hasValueDiscussionSignal", "hasNextStepSignal"];
  if (!hasExactKeys(features, featureKeys)
      || !["unknown", "low", "medium", "high"].includes(features.messageCountBucket as string)
      || !featureKeys.slice(1).every((key) => typeof features[key] === "boolean")) return null;
  return {
    recordKind: "classifier",
    roleId: payload.roleId,
    relationshipStage: payload.relationshipStage,
    goalCategory: payload.goalCategory,
    provenance: "human_confirmed",
    classifierFeatures: {
      messageCountBucket: features.messageCountBucket,
      hasIncomingQuestion: features.hasIncomingQuestion,
      hasNeedSignal: features.hasNeedSignal,
      hasPermissionSignal: features.hasPermissionSignal,
      hasValueDiscussionSignal: features.hasValueDiscussionSignal,
      hasNextStepSignal: features.hasNextStepSignal,
    },
  };
}

function normalizedEvaluationPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!hasExactKeys(payload, ["recordKind", "roleId", "relationshipStage", "goalCategory", "provenance", "evaluationAction"])
      || payload.recordKind !== "evaluation" || payload.provenance !== "human_confirmed"
      || typeof payload.roleId !== "string" || typeof payload.relationshipStage !== "string" || typeof payload.goalCategory !== "string"
      || !ROLE_IDS.has(payload.roleId)
      || !Object.hasOwn(GOAL_CATEGORY_BY_STAGE, payload.relationshipStage)
      || GOAL_CATEGORY_BY_STAGE[payload.relationshipStage as keyof typeof GOAL_CATEGORY_BY_STAGE] !== payload.goalCategory
      || !["useful", "not_useful", "accepted", "edited", "rejected"].includes(payload.evaluationAction as string)) return null;
  return { recordKind: "evaluation", roleId: payload.roleId, relationshipStage: payload.relationshipStage, goalCategory: payload.goalCategory, provenance: "human_confirmed", evaluationAction: payload.evaluationAction };
}

function normalizedGenerativePayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (!hasExactKeys(payload, ["recordKind", "roleId", "relationshipStage", "goalCategory", "provenance", "target", "rightsAttested", "privacyAttested"])
      || payload.recordKind !== "generative" || payload.provenance !== "independently_user_authored"
      || typeof payload.roleId !== "string" || typeof payload.relationshipStage !== "string" || typeof payload.goalCategory !== "string"
      || !ROLE_IDS.has(payload.roleId)
      || !Object.hasOwn(GOAL_CATEGORY_BY_STAGE, payload.relationshipStage)
      || GOAL_CATEGORY_BY_STAGE[payload.relationshipStage as keyof typeof GOAL_CATEGORY_BY_STAGE] !== payload.goalCategory
      || typeof payload.target !== "string" || !payload.target.trim() || payload.target.length > 2_000
      || payload.rightsAttested !== true || payload.privacyAttested !== true) return null;
  return { recordKind: "generative", roleId: payload.roleId, relationshipStage: payload.relationshipStage, goalCategory: payload.goalCategory, provenance: "independently_user_authored", target: payload.target.normalize("NFC").trim(), rightsAttested: true, privacyAttested: true };
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function normalizeDraftLearningDecision(value: unknown): DraftLearningDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!hasExactKeys(item, ["recordId", "state", "syncStatus", "updatedAt"])
      || typeof item.recordId !== "string" || !/^[a-z0-9-]{1,64}$/u.test(item.recordId)
      || (item.state !== "useful" && item.state !== "not_useful" && item.state !== "authored")
      || (item.syncStatus !== "pending" && item.syncStatus !== "synced" && item.syncStatus !== "failed")) return undefined;
  const updatedAt = canonicalTimestamp(item.updatedAt);
  return updatedAt ? { recordId: item.recordId, state: item.state, syncStatus: item.syncStatus, updatedAt } : undefined;
}

function normalizeDraftLearningDecisionPayload(value: unknown): DraftLearningDecisionPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.kind === "evaluation") {
    if (!hasExactKeys(item, ["kind", "roleId", "relationshipStage", "goalCategory", "action"])
        || typeof item.roleId !== "string" || typeof item.relationshipStage !== "string" || typeof item.goalCategory !== "string"
        || !ROLE_IDS.has(item.roleId) || !Object.hasOwn(GOAL_CATEGORY_BY_STAGE, item.relationshipStage)
        || GOAL_CATEGORY_BY_STAGE[item.relationshipStage as keyof typeof GOAL_CATEGORY_BY_STAGE] !== item.goalCategory
        || (item.action !== "useful" && item.action !== "not_useful")) return null;
    return { kind: "evaluation", roleId: item.roleId as DraftLearningDecisionPayload["roleId"], relationshipStage: item.relationshipStage as DraftLearningDecisionPayload["relationshipStage"], goalCategory: item.goalCategory as DraftLearningDecisionPayload["goalCategory"], action: item.action };
  }
  if (!hasExactKeys(item, ["kind", "roleId", "relationshipStage", "goalCategory", "provenance", "target", "rightsAttested", "privacyAttested"])
      || item.kind !== "generative" || typeof item.roleId !== "string" || typeof item.relationshipStage !== "string" || typeof item.goalCategory !== "string"
      || !ROLE_IDS.has(item.roleId) || !Object.hasOwn(GOAL_CATEGORY_BY_STAGE, item.relationshipStage)
      || GOAL_CATEGORY_BY_STAGE[item.relationshipStage as keyof typeof GOAL_CATEGORY_BY_STAGE] !== item.goalCategory
      || item.provenance !== "independently_user_authored" || typeof item.target !== "string" || !item.target.trim() || item.target.length > 2_000
      || item.rightsAttested !== true || item.privacyAttested !== true) return null;
  return { kind: "generative", roleId: item.roleId as DraftLearningDecisionPayload["roleId"], relationshipStage: item.relationshipStage as DraftLearningDecisionPayload["relationshipStage"], goalCategory: item.goalCategory as DraftLearningDecisionPayload["goalCategory"], provenance: "independently_user_authored", target: item.target.normalize("NFC").trim(), rightsAttested: true, privacyAttested: true };
}

function normalizePendingLearningRecord(value: unknown, index: number, fallbackNow: string): PendingLearningRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.mutationKind === "draft_decision") {
    if (!hasExactKeys(item, ["mutationKind", "recordId", "decision", "sourceCollection", "sourceLocalId", "createdAt", "expiresAt"])
        || typeof item.recordId !== "string" || !/^[a-z0-9-]{1,64}$/u.test(item.recordId)
        || item.sourceCollection !== "draftHistory" || typeof item.sourceLocalId !== "string" || !item.sourceLocalId || item.sourceLocalId.length > 200) return null;
    const decision = normalizeDraftLearningDecisionPayload(item.decision);
    const createdAt = canonicalTimestamp(item.createdAt);
    const expiresAt = canonicalTimestamp(item.expiresAt);
    if (!decision || !createdAt || !expiresAt || Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) > Date.parse(createdAt) + LEARNING_RETENTION_DAYS * 86_400_000) return null;
    return { mutationKind: "draft_decision", recordId: item.recordId, decision, sourceCollection: "draftHistory", sourceLocalId: item.sourceLocalId, createdAt, expiresAt };
  }
  if (item.mutationKind !== undefined && item.mutationKind !== "record_upload"
      || item.recordKind !== "classifier" && item.recordKind !== "evaluation" && item.recordKind !== "generative"
      || item.sourceCollection !== "feedback" && item.sourceCollection !== "stageTrainingRecords") return null;
  const recordId = typeof item.recordId === "string" ? item.recordId.slice(0, 64) : "";
  const sourceLocalId = typeof item.sourceLocalId === "string" ? item.sourceLocalId.slice(0, 200) : "";
  const sanitizedPayload = item.recordKind === "classifier"
    ? normalizedClassifierPayload(item.sanitizedPayload)
    : item.recordKind === "evaluation"
      ? normalizedEvaluationPayload(item.sanitizedPayload)
      : normalizedGenerativePayload(item.sanitizedPayload);
  if (!recordId || !sourceLocalId || !sanitizedPayload) return null;
  const createdAt = normalizedLearningTimestamp(item.createdAt, fallbackNow);
  const expiresAt = normalizedLearningTimestamp(item.expiresAt, new Date(Date.parse(createdAt) + LEARNING_RETENTION_DAYS * 86_400_000).toISOString());
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) > Date.parse(createdAt) + LEARNING_RETENTION_DAYS * 86_400_000) return null;
  return { mutationKind: "record_upload", recordId: recordId || `pending-${index}`, recordKind: item.recordKind, sanitizedPayload, sourceCollection: item.sourceCollection, sourceLocalId, createdAt, expiresAt };
}

function normalizeCloudLearningSyncEntry(value: unknown, fallbackNow: string): CloudLearningSyncEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const recordId = typeof item.recordId === "string" ? item.recordId.slice(0, 64) : "";
  const contentDigest = typeof item.contentDigest === "string" && /^[a-f0-9]{64}$/u.test(item.contentDigest) ? item.contentDigest : "";
  if (!recordId || !contentDigest || item.status !== "pending" && item.status !== "synced" && item.status !== "failed") return null;
  return { recordId, contentDigest, status: item.status, updatedAt: normalizedLearningTimestamp(item.updatedAt, fallbackNow) };
}

function normalizeCloudLearningDeletionMarker(value: unknown, fallbackNow: string): CloudLearningDeletionMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const recordId = typeof item.recordId === "string" && /^[a-z0-9-]{1,64}$/u.test(item.recordId) ? item.recordId : "";
  const sourceCollection = item.sourceCollection === "feedback" || item.sourceCollection === "stageTrainingRecords" || item.sourceCollection === "draftHistory" ? item.sourceCollection : "";
  const sourceLocalId = typeof item.sourceLocalId === "string" ? item.sourceLocalId.slice(0, 200) : "";
  if (!recordId || item.disposition !== "acknowledged" && item.disposition !== "deleted") return null;
  if (item.disposition === "acknowledged" && (!sourceCollection || !sourceLocalId)) return null;
  const deletedAt = new Date(Date.parse(normalizedLearningTimestamp(item.deletedAt, fallbackNow))).toISOString();
  return { recordId, disposition: item.disposition, sourceCollection, sourceLocalId, deletedAt };
}

function normalizeCloudLearningDeletionMarkers(value: unknown, fallbackNow: string): CloudLearningDeletionMarker[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, CloudLearningDeletionMarker>();
  for (const marker of value) {
    const normalized = normalizeCloudLearningDeletionMarker(marker, fallbackNow);
    if (!normalized) continue;
    const current = merged.get(normalized.recordId);
    if (!current
        || current.disposition === "deleted" && normalized.disposition === "deleted" && Date.parse(normalized.deletedAt) > Date.parse(current.deletedAt)
        || current.disposition !== "deleted" && (normalized.disposition === "deleted" || Date.parse(normalized.deletedAt) > Date.parse(current.deletedAt))) merged.set(normalized.recordId, normalized);
  }
  return [...merged.values()].sort((left, right) => Date.parse(left.deletedAt) - Date.parse(right.deletedAt)
    || left.recordId.localeCompare(right.recordId)
    || left.disposition.localeCompare(right.disposition)
    || left.sourceCollection.localeCompare(right.sourceCollection)
    || left.sourceLocalId.localeCompare(right.sourceLocalId)).slice(-MAX_CLOUD_LEARNING_DELETION_MARKERS);
}

function appendUniquePendingRecords(workspace: WorkspaceData, records: PendingLearningRecord[]): WorkspaceData {
  const seen = new Set(workspace.pendingLearningRecords.map((record) => record.recordId));
  const pendingLearningRecords = [...workspace.pendingLearningRecords];
  for (const record of records) {
    if (seen.has(record.recordId)) continue;
    seen.add(record.recordId);
    pendingLearningRecords.push(record);
  }
  return { ...workspace, pendingLearningRecords: pendingLearningRecords.slice(-MAX_PENDING_LEARNING_RECORDS) };
}

export function migrateEligibleLegacyLearning(workspace: WorkspaceData, now = new Date()): WorkspaceData {
  const fallbackNow = now.toISOString();
  const classifier = workspace.stageTrainingRecords.flatMap((record): PendingLearningRecord[] => {
    if (!record.humanConfirmed) return [];
    const roleId = ROLE_ID_BY_MESSAGING_ROLE[record.role];
    const goalCategory = GOAL_CATEGORY_BY_STAGE[record.confirmedStage];
    const createdAt = normalizedLearningTimestamp(record.createdAt, fallbackNow);
    const expiresAt = new Date(Date.parse(createdAt) + LEARNING_RETENTION_DAYS * 86_400_000).toISOString();
    return [{
      mutationKind: "record_upload",
      recordId: `legacy-stage-${record.id}`.slice(0, 64),
      recordKind: "classifier",
      sanitizedPayload: {
        recordKind: "classifier",
        roleId,
        relationshipStage: record.confirmedStage,
        goalCategory,
        provenance: "human_confirmed",
        classifierFeatures: {
          messageCountBucket: record.messageCountBucket,
          hasIncomingQuestion: record.hasIncomingQuestion,
          hasNeedSignal: record.hasNeedSignal,
          hasPermissionSignal: record.hasPermissionSignal,
          hasValueDiscussionSignal: record.hasValueDiscussionSignal,
          hasNextStepSignal: record.hasNextStepSignal,
        },
      },
      sourceCollection: "stageTrainingRecords",
      sourceLocalId: record.id,
      createdAt,
      expiresAt,
    }];
  });
  return appendUniquePendingRecords(workspace, classifier);
}

export function normalizeWorkspace(value: unknown): WorkspaceData {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const contacts = Array.isArray(source.contacts) ? source.contacts : [];
  const cloudInference = source.cloudInference && typeof source.cloudInference === "object"
    ? source.cloudInference as Record<string, unknown>
    : {};
  const cloudRecovery = source.cloudRecovery && typeof source.cloudRecovery === "object"
    ? source.cloudRecovery as Record<string, unknown>
    : {};
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
  const fallbackNow = new Date().toISOString();
  const normalized: WorkspaceData = {
    version: 15,
    modelId: normalizeWorkspaceModelId(),
    cloudInference: {
      consentedAt: typeof cloudInference.consentedAt === "string" ? cloudInference.consentedAt.slice(0, 100) : "",
    },
    cloudRecovery: {
      enabled: cloudRecovery.enabled === true,
      revision: typeof cloudRecovery.revision === "number" && Number.isFinite(cloudRecovery.revision) ? Math.max(0, Math.floor(cloudRecovery.revision)) : 0,
      lastConfirmedDigest: typeof cloudRecovery.lastConfirmedDigest === "string" ? cloudRecovery.lastConfirmedDigest.slice(0, 100) : "",
      lastConfirmedCiphertextDigest: typeof cloudRecovery.lastConfirmedCiphertextDigest === "string" ? cloudRecovery.lastConfirmedCiphertextDigest.slice(0, 100) : "",
      lastConfirmedContacts: typeof cloudRecovery.lastConfirmedContacts === "number" && Number.isFinite(cloudRecovery.lastConfirmedContacts) ? Math.max(0, Math.floor(cloudRecovery.lastConfirmedContacts)) : 0,
      lastConfirmedMessages: typeof cloudRecovery.lastConfirmedMessages === "number" && Number.isFinite(cloudRecovery.lastConfirmedMessages) ? Math.max(0, Math.floor(cloudRecovery.lastConfirmedMessages)) : 0,
      lastSyncedAt: typeof cloudRecovery.lastSyncedAt === "string" ? cloudRecovery.lastSyncedAt.slice(0, 100) : "",
    },
    deletionTombstones: Array.isArray(source.deletionTombstones) ? source.deletionTombstones.slice(-1000).flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const tombstone = raw as Record<string, unknown>;
      const contactId = typeof tombstone.contactId === "string" ? tombstone.contactId.slice(0, 200) : "";
      const deletedAt = typeof tombstone.deletedAt === "string" ? tombstone.deletedAt.slice(0, 100) : "";
      if (!contactId || !deletedAt) return [];
      const identityHashes = Array.isArray(tombstone.identityHashes)
        ? Array.from(new Set(tombstone.identityHashes.filter((hash): hash is string => typeof hash === "string").map((hash) => hash.slice(0, 100)).filter(Boolean))).slice(0, 10)
        : [];
      return [{ contactId, identityHashes, deletedAt }];
    }) : [],
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
        lastReadIncomingMessageId: typeof contact.lastReadIncomingMessageId === "string" ? contact.lastReadIncomingMessageId.slice(0, 500) : "",
        lastSyncDiagnostic: normalizeSyncDiagnostic(contact.lastSyncDiagnostic),
        draftHistory: Array.isArray(contact.draftHistory) ? contact.draftHistory.slice(-20).flatMap((draft, draftIndex) => {
          if (!draft || typeof draft !== "object") return [];
          const item = draft as Record<string, unknown>;
          const drafts = Array.isArray(item.drafts) ? item.drafts.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 5_000)).slice(0, 3) : [];
          if (!drafts.length) return [];
          const provider = item.provider === "anthropic" || item.provider === "cloudflare" || item.provider === "local" ? item.provider : undefined;
           const learningDecision = normalizeDraftLearningDecision(item.learningDecision);
           return [{ id: typeof item.id === "string" ? item.id.slice(0, 200) : `draft-history-${draftIndex}`, agenda: typeof item.agenda === "string" ? item.agenda.slice(0, 5_000) : "", drafts, createdAt: typeof item.createdAt === "string" ? item.createdAt.slice(0, 100) : new Date().toISOString(), role: isMessagingRole(item.role) ? item.role : inboxRole, provider, modelId: typeof item.modelId === "string" ? item.modelId.slice(0, 300) : undefined, ...(learningDecision ? { learningDecision } : {}) }];
        }) : [],
        relationshipStage: normalizeRelationshipStage(contact.relationshipStage),
        conversationGoal: typeof contact.conversationGoal === "string" ? contact.conversationGoal.slice(0, CONVERSATION_GOAL_MAX_CHARS) : "",
      };
    }),
    feedback: Array.isArray(source.feedback) ? source.feedback.slice(-1000).flatMap((feedback, feedbackIndex) => {
      const normalized = normalizeFeedback(feedback, feedbackIndex);
      return normalized ? [normalized] : [];
    }) : [],
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
    personalGuidelines: normalizePersonalGuidelines(source.personalGuidelines),
    personalLearning: {
      enabled: !(source.personalLearning && typeof source.personalLearning === "object" && (source.personalLearning as Record<string, unknown>).enabled === false),
    },
    stageTrainingRecords: Array.isArray(source.stageTrainingRecords) ? source.stageTrainingRecords.slice(-2_000).flatMap((record, recordIndex) => {
      const normalized = normalizeStageTrainingRecord(record, recordIndex);
      return normalized ? [normalized] : [];
    }) : [],
    pendingLearningRecords: Array.isArray(source.pendingLearningRecords)
      ? source.pendingLearningRecords.slice(-MAX_PENDING_LEARNING_RECORDS).flatMap((record, recordIndex) => {
        const normalized = normalizePendingLearningRecord(record, recordIndex, fallbackNow);
        return normalized ? [normalized] : [];
      })
      : [],
    cloudLearningSync: Array.isArray(source.cloudLearningSync)
      ? source.cloudLearningSync.slice(-MAX_CLOUD_LEARNING_SYNC_ENTRIES).flatMap((entry) => {
        const normalized = normalizeCloudLearningSyncEntry(entry, fallbackNow);
        return normalized ? [normalized] : [];
      })
      : [],
    cloudLearningDeletionMarkers: normalizeCloudLearningDeletionMarkers(source.cloudLearningDeletionMarkers, fallbackNow),
    cloudLearningClearedAt: typeof source.cloudLearningClearedAt === "string" && Number.isFinite(Date.parse(source.cloudLearningClearedAt))
      ? new Date(Date.parse(source.cloudLearningClearedAt)).toISOString()
      : "",
  };
  return source.version === 14 || source.version === 15 ? normalized : migrateEligibleLegacyLearning(normalized);
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
