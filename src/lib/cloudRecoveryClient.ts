import { isCloudVaultEnvelope, serializeCloudVaultEnvelope, type CloudVaultEnvelopeV1 } from "./cloudRecovery";

const MAX_RESPONSE_BYTES = 11 * 1024 * 1024;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

export type CloudRecoveryTransportCode = "authentication" | "not-found" | "conflict" | "too-large" | "unavailable" | "invalid";

export class CloudRecoveryTransportError extends Error {
  constructor(public readonly code: CloudRecoveryTransportCode, message: string) {
    super(message);
    this.name = "CloudRecoveryTransportError";
  }
}

export interface CloudVaultReadResult {
  envelope: CloudVaultEnvelopeV1;
  revision: number;
  ciphertextDigest: string;
}

export interface CloudVaultWriteResult {
  revision: number;
  ciphertextDigest: string;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function transportError(status: number): CloudRecoveryTransportError {
  if (status === 401 || status === 403) return new CloudRecoveryTransportError("authentication", "Your DialogMint sign-in session could not be verified. Refresh and sign in again if asked.");
  if (status === 404) return new CloudRecoveryTransportError("not-found", "No encrypted DialogMint backup was found.");
  if (status === 409) return new CloudRecoveryTransportError("conflict", "The encrypted backup changed on another device.");
  if (status === 413) return new CloudRecoveryTransportError("too-large", "The encrypted DialogMint backup is too large.");
  return new CloudRecoveryTransportError("unavailable", "Encrypted backup is temporarily unavailable.");
}

async function responseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    if (response.ok || response.status === 401 || response.status === 403) throw transportError(401);
    throw transportError(response.status);
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new CloudRecoveryTransportError("too-large", "The encrypted DialogMint backup response is too large.");
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) throw new CloudRecoveryTransportError("too-large", "The encrypted DialogMint backup response is too large.");
  try {
    return JSON.parse(raw);
  } catch {
    throw new CloudRecoveryTransportError("invalid", "DialogMint received an invalid encrypted backup response.");
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validConfirmation(value: unknown): value is CloudVaultWriteResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<CloudVaultWriteResult>;
  return Number.isSafeInteger(item.revision) && Number(item.revision) > 0 && typeof item.ciphertextDigest === "string" && HEX_DIGEST.test(item.ciphertextDigest);
}

export async function readCloudVault(fetchImpl: FetchLike = fetch): Promise<CloudVaultReadResult | null> {
  const response = await fetchImpl("/api/vault", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) return null;
  const payload = await responseJson(response);
  if (!response.ok) throw transportError(response.status);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new CloudRecoveryTransportError("invalid", "DialogMint received an invalid encrypted backup response.");
  const item = payload as Partial<CloudVaultReadResult>;
  if (!isCloudVaultEnvelope(item.envelope) || !Number.isSafeInteger(item.revision) || Number(item.revision) <= 0 || typeof item.ciphertextDigest !== "string" || !HEX_DIGEST.test(item.ciphertextDigest)) {
    throw new CloudRecoveryTransportError("invalid", "DialogMint received an invalid encrypted backup response.");
  }
  if (await sha256Hex(serializeCloudVaultEnvelope(item.envelope)) !== item.ciphertextDigest) throw new CloudRecoveryTransportError("invalid", "DialogMint received an invalid encrypted backup response.");
  return { envelope: item.envelope, revision: Number(item.revision), ciphertextDigest: item.ciphertextDigest };
}

export async function writeCloudVault(envelope: CloudVaultEnvelopeV1, expectedRevision: number, fetchImpl: FetchLike = fetch): Promise<CloudVaultWriteResult> {
  if (!isCloudVaultEnvelope(envelope) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CloudRecoveryTransportError("invalid", "This encrypted DialogMint backup is not valid.");
  const ciphertextDigest = await sha256Hex(serializeCloudVaultEnvelope(envelope));
  const response = await fetchImpl("/api/vault", {
    method: "PUT",
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ envelope, expectedRevision, ciphertextDigest }),
  });
  const payload = await responseJson(response);
  if (!response.ok) throw transportError(response.status);
  if (!validConfirmation(payload) || payload.ciphertextDigest !== ciphertextDigest) throw new CloudRecoveryTransportError("invalid", "DialogMint received an invalid encrypted backup confirmation.");
  return payload;
}

export async function deleteCloudVault(fetchImpl: FetchLike = fetch): Promise<void> {
  const response = await fetchImpl("/api/vault", {
    method: "DELETE",
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    headers: { Accept: "application/json" },
  });
  if (response.status === 204) return;
  if (!response.ok) {
    if ((response.headers.get("Content-Type") ?? "").toLowerCase().includes("application/json")) await responseJson(response);
    throw transportError(response.status);
  }
  throw new CloudRecoveryTransportError("invalid", "DialogMint received an invalid encrypted backup response.");
}
