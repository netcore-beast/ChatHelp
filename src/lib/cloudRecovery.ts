import { applyRetention } from "./retention";
import { normalizeWorkspace } from "./secureVault";
import { createEmptyWorkspace, type WorkspaceData } from "./workspaceTypes";

export type CloudEnvironment = "testing" | "production";

export interface DialogMintRecoveryBundleV1 {
  version: 1;
  encryptionKey: string;
}

export interface CloudVaultEnvelopeV1 {
  format: "dialogmint-cloud-v1";
  schemaVersion: 10;
  iv: string;
  ciphertext: string;
  encryptedBytes: number;
  savedAt: string;
}

export interface CloudBackupSummary {
  logicalDigest: string;
  ciphertextDigest: string;
  contactCount: number;
  messageCount: number;
}

const CLOUD_RETENTION_DAYS = 90;
const RECOVERY_KEY_BYTES = 32;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recoveryAad(environment: CloudEnvironment): Uint8Array {
  return new TextEncoder().encode(`DialogMint cloud vault v1:${environment}:schema-10`);
}

function retainedWithinCloudWindow(createdAt: string, now: number): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp >= now - CLOUD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

export async function createRecoveryBundle(): Promise<DialogMintRecoveryBundleV1> {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  return { version: 1, encryptionKey: bytesToBase64Url(bytes) };
}

export function serializeRecoveryBundle(bundle: DialogMintRecoveryBundleV1): string {
  return JSON.stringify(bundle, null, 2);
}

export function parseRecoveryBundle(raw: string): DialogMintRecoveryBundleV1 | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join(",") !== "encryptionKey,version") return null;
    if (value.version !== 1 || typeof value.encryptionKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.encryptionKey)) return null;
    if (base64UrlToBytes(value.encryptionKey).length !== RECOVERY_KEY_BYTES) return null;
    return { version: 1, encryptionKey: value.encryptionKey };
  } catch {
    return null;
  }
}

export async function importRecoveryKey(encodedKey: string): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) throw new Error("This is not a valid DialogMint recovery file.");
  const bytes = base64UrlToBytes(encodedKey);
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new Error("This is not a valid DialogMint recovery file.");
  return crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function createCloudSafeWorkspace(workspace: WorkspaceData, _environment: CloudEnvironment, now = Date.now()): WorkspaceData {
  const retained = applyRetention(normalizeWorkspace(workspace), now);
  const empty = createEmptyWorkspace();
  return {
    ...retained,
    cloudInference: { consentedAt: "" },
    cloudRecovery: { ...empty.cloudRecovery },
    contacts: retained.contacts.map((contact) => ({
      ...contact,
      chat: contact.chat.filter((message) => retainedWithinCloudWindow(message.createdAt, now)),
      documents: contact.documents.filter((document) => retainedWithinCloudWindow(document.createdAt, now)),
      outcomes: contact.outcomes.filter((outcome) => retainedWithinCloudWindow(outcome.createdAt, now)),
      draftHistory: (contact.draftHistory ?? []).filter((draft) => retainedWithinCloudWindow(draft.createdAt, now)),
      lastSyncDiagnostic: undefined,
    })),
    feedback: retained.feedback.filter((item) => retainedWithinCloudWindow(item.createdAt, now)),
    aiUsage: retained.aiUsage.filter((item) => retainedWithinCloudWindow(item.createdAt, now)),
  };
}

export async function encryptCloudWorkspace(workspace: WorkspaceData, key: CryptoKey, environment: CloudEnvironment, savedAt = new Date().toISOString()): Promise<CloudVaultEnvelopeV1> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(normalizeWorkspace(workspace)));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: recoveryAad(environment) as BufferSource },
    key,
    plaintext as BufferSource,
  ));
  return {
    format: "dialogmint-cloud-v1",
    schemaVersion: 10,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext),
    encryptedBytes: ciphertext.byteLength,
    savedAt,
  };
}

function isCloudVaultEnvelope(value: unknown): value is CloudVaultEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<CloudVaultEnvelopeV1>;
  return item.format === "dialogmint-cloud-v1" && item.schemaVersion === 10 &&
    typeof item.iv === "string" && /^[A-Za-z0-9_-]{16}$/.test(item.iv) &&
    typeof item.ciphertext === "string" && /^[A-Za-z0-9_-]+$/.test(item.ciphertext) &&
    typeof item.encryptedBytes === "number" && Number.isSafeInteger(item.encryptedBytes) && item.encryptedBytes > 0 &&
    typeof item.savedAt === "string";
}

export async function decryptCloudWorkspace(envelope: CloudVaultEnvelopeV1, key: CryptoKey, environment: CloudEnvironment): Promise<WorkspaceData> {
  if (!isCloudVaultEnvelope(envelope)) throw new Error("This encrypted DialogMint backup is not valid.");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(envelope.iv) as BufferSource, additionalData: recoveryAad(environment) as BufferSource },
      key,
      base64UrlToBytes(envelope.ciphertext) as BufferSource,
    );
    return normalizeWorkspace(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error("This recovery file does not unlock the encrypted DialogMint backup.");
  }
}

export async function summarizeCloudBackup(workspace: WorkspaceData, envelope: CloudVaultEnvelopeV1): Promise<CloudBackupSummary> {
  return {
    logicalDigest: await sha256Hex(JSON.stringify(normalizeWorkspace(workspace))),
    ciphertextDigest: await sha256Hex(JSON.stringify(envelope)),
    contactCount: workspace.contacts.length,
    messageCount: workspace.contacts.reduce((total, contact) => total + contact.chat.length, 0),
  };
}
