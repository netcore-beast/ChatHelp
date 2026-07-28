import { createEmptyWorkspace, DEFAULT_MODEL_ID, type Contact, type Message, type WorkspaceData } from "./workspaceTypes";

const DB_NAME = "chathelp-secure";
const DB_VERSION = 1;
const STORE_NAME = "vault";
const RECORD_KEY = "primary";
const AAD = new TextEncoder().encode("ChatHelp vault v1");
export const KDF_ITERATIONS = 600_000;

export interface VaultEnvelope {
  format: "chathelp-encrypted-v1";
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string; ciphertext: string };
  updatedAt: string;
}

export interface VaultSession {
  key: CryptoKey;
  salt: Uint8Array;
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
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open secure storage"));
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

function assertEnvelope(value: unknown): asserts value is VaultEnvelope {
  const item = value as Partial<VaultEnvelope> | null;
  if (!item || item.format !== "chathelp-encrypted-v1" || item.kdf?.name !== "PBKDF2" ||
      item.kdf.hash !== "SHA-256" || item.cipher?.name !== "AES-GCM" ||
      typeof item.kdf.salt !== "string" || typeof item.cipher.iv !== "string" ||
      typeof item.cipher.ciphertext !== "string" || !Number.isSafeInteger(item.kdf.iterations)) {
    throw new Error("This is not a valid ChatHelp encrypted backup.");
  }
}

async function encryptWorkspace(workspace: WorkspaceData, session: VaultSession): Promise<VaultEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(workspace));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD as BufferSource },
    session.key,
    plaintext as BufferSource,
  );
  return {
    format: "chathelp-encrypted-v1",
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: bytesToBase64(session.salt) },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) },
    updatedAt: new Date().toISOString(),
  };
}

async function decryptEnvelope(envelope: VaultEnvelope, passphrase: string): Promise<{ workspace: WorkspaceData; session: VaultSession }> {
  const salt = base64ToBytes(envelope.kdf.salt);
  const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.cipher.iv) as BufferSource, additionalData: AAD as BufferSource },
      key,
      base64ToBytes(envelope.cipher.ciphertext) as BufferSource,
    );
    const workspace = normalizeWorkspace(JSON.parse(new TextDecoder().decode(plaintext)));
    return { workspace, session: { key, salt } };
  } catch {
    throw new Error("Incorrect passphrase or the encrypted vault has been changed.");
  }
}

export async function vaultExists(): Promise<boolean> {
  return Boolean(await withStore("readonly", (store) => store.get(RECORD_KEY)));
}

export async function createVault(passphrase: string, workspace = createEmptyWorkspace()): Promise<{ workspace: WorkspaceData; session: VaultSession }> {
  if (passphrase.length < 12) throw new Error("Use a passphrase with at least 12 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const session = { key, salt };
  const envelope = await encryptWorkspace(workspace, session);
  await withStore("readwrite", (store) => store.put(envelope, RECORD_KEY));
  return { workspace, session };
}

export async function unlockVault(passphrase: string): Promise<{ workspace: WorkspaceData; session: VaultSession }> {
  const envelope = await withStore<VaultEnvelope | undefined>("readonly", (store) => store.get(RECORD_KEY));
  if (!envelope) throw new Error("No secure vault exists on this browser profile.");
  assertEnvelope(envelope);
  return decryptEnvelope(envelope, passphrase);
}

export async function saveVault(workspace: WorkspaceData, session: VaultSession): Promise<void> {
  const envelope = await encryptWorkspace(normalizeWorkspace(workspace), session);
  await withStore("readwrite", (store) => store.put(envelope, RECORD_KEY));
}

export async function exportEncryptedBackup(): Promise<string> {
  const envelope = await withStore<VaultEnvelope | undefined>("readonly", (store) => store.get(RECORD_KEY));
  if (!envelope) throw new Error("No secure vault exists to export.");
  assertEnvelope(envelope);
  return JSON.stringify(envelope, null, 2);
}

export async function importEncryptedBackup(contents: string, passphrase: string): Promise<{ workspace: WorkspaceData; session: VaultSession }> {
  const envelope: unknown = JSON.parse(contents);
  assertEnvelope(envelope);
  const unlocked = await decryptEnvelope(envelope, passphrase);
  await withStore("readwrite", (store) => store.put(envelope, RECORD_KEY));
  return unlocked;
}

export async function eraseVault(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(RECORD_KEY));
}

function normalizeMessage(value: Partial<Message>, index: number): Message {
  return {
    id: typeof value.id === "string" ? value.id : "message-" + index,
    role: value.role === "them" ? "them" : "me",
    body: typeof value.body === "string" ? value.body.slice(0, 20_000) : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
  };
}

export function normalizeWorkspace(value: unknown): WorkspaceData {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const empty = createEmptyWorkspace();
  const contacts = Array.isArray(source.contacts) ? source.contacts : [];
  return {
    version: 3,
    modelId: typeof source.modelId === "string" ? source.modelId : DEFAULT_MODEL_ID,
    guidance: {
      role: typeof (source.guidance as Record<string, unknown> | undefined)?.role === "string" ? String((source.guidance as Record<string, unknown>).role) : empty.guidance.role,
      objective: typeof (source.guidance as Record<string, unknown> | undefined)?.objective === "string" ? String((source.guidance as Record<string, unknown>).objective) : empty.guidance.objective,
      voice: typeof (source.guidance as Record<string, unknown> | undefined)?.voice === "string" ? String((source.guidance as Record<string, unknown>).voice) : empty.guidance.voice,
      boundaries: typeof (source.guidance as Record<string, unknown> | undefined)?.boundaries === "string" ? String((source.guidance as Record<string, unknown>).boundaries) : empty.guidance.boundaries,
    },
    contacts: contacts.slice(0, 100).map((raw, index): Contact => {
      const contact = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const captured = typeof contact.capturedContext === "string" ? contact.capturedContext : "";
      return {
        id: typeof contact.id === "string" ? contact.id : "contact-" + index,
        name: typeof contact.name === "string" ? contact.name.slice(0, 200) : "Unknown contact",
        headline: typeof contact.headline === "string" ? contact.headline.slice(0, 500) : "",
        profileNotes: typeof contact.profileNotes === "string" ? contact.profileNotes.slice(0, 20_000) : "",
        chat: Array.isArray(contact.chat) ? contact.chat.slice(-1000).map((message, messageIndex) => normalizeMessage(message as Partial<Message>, messageIndex)) : [],
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
      };
    }),
    feedback: Array.isArray(source.feedback) ? source.feedback.slice(-1000) as WorkspaceData["feedback"] : [],
  };
}

export function parseLegacyWorkspace(raw: string | null): WorkspaceData | null {
  if (!raw) return null;
  try { return normalizeWorkspace(JSON.parse(raw)); } catch { return null; }
}

export async function resetVaultForTests(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Vault database deletion was blocked"));
  });
}
