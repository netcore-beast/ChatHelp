import { Client } from "pg";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const PRODUCTION_HOST = "chathelp-private-cloud.project-mission-ai.workers.dev";
const MAX_VAULT_REQUEST_BYTES = 10 * 1024 * 1024;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+$/;

const VAULT_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...VAULT_HEADERS, ...extraHeaders } });
}

export function resolveVaultBinding(hostname, env) {
  if (hostname === TESTING_HOST) return env.NEON_TESTING?.connectionString ? env.NEON_TESTING : null;
  if (hostname === PRODUCTION_HOST) return env.NEON_PRODUCTION?.connectionString ? env.NEON_PRODUCTION : null;
  return null;
}

function expectedEnvironment(hostname) {
  if (hostname === TESTING_HOST) return "testing";
  if (hostname === PRODUCTION_HOST) return "production";
  return "";
}

async function queryDatabase(binding, text, values, options) {
  if (typeof options?.query === "function") return options.query(binding, text, values);
  const client = new Client({ connectionString: binding.connectionString });
  try {
    await client.connect();
    return await client.query(text, values);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function base64UrlBytes(value) {
  if (typeof value !== "string" || !BASE64_URL.test(value)) return -1;
  const remainder = value.length % 4;
  if (remainder === 1) return -1;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - remainder) % 4);
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).byteLength;
  } catch {
    return -1;
  }
}

function validEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "ciphertext,encryptedBytes,format,iv,savedAt,schemaVersion") return false;
  if (value.format !== "dialogmint-cloud-v1" || value.schemaVersion !== 10) return false;
  if (typeof value.iv !== "string" || value.iv.length !== 16 || base64UrlBytes(value.iv) !== 12) return false;
  if (!Number.isSafeInteger(value.encryptedBytes) || value.encryptedBytes <= 0 || value.encryptedBytes > MAX_VAULT_REQUEST_BYTES) return false;
  if (base64UrlBytes(value.ciphertext) !== value.encryptedBytes) return false;
  return typeof value.savedAt === "string" && value.savedAt.length <= 100 && Number.isFinite(Date.parse(value.savedAt));
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serializeEnvelope(envelope) {
  return JSON.stringify({
    format: envelope.format,
    schemaVersion: envelope.schemaVersion,
    iv: envelope.iv,
    ciphertext: envelope.ciphertext,
    encryptedBytes: envelope.encryptedBytes,
    savedAt: envelope.savedAt,
  });
}

async function parseVaultWrite(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return { response: json({ error: "Expected a JSON request." }, 415) };
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VAULT_REQUEST_BYTES) {
    return { response: json({ error: "Encrypted backup is too large." }, 413) };
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { response: json({ error: "Encrypted backup request is invalid." }, 400) };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_VAULT_REQUEST_BYTES) {
    return { response: json({ error: "Encrypted backup is too large." }, 413) };
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { response: json({ error: "Encrypted backup request is invalid." }, 400) };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).sort().join(",") !== "ciphertextDigest,envelope,expectedRevision") {
    return { response: json({ error: "Encrypted backup request is invalid." }, 400) };
  }
  if (!validEnvelope(payload.envelope) || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0 || !HEX_DIGEST.test(payload.ciphertextDigest ?? "")) {
    return { response: json({ error: "Encrypted backup request is invalid." }, 400) };
  }
  if (await sha256Hex(serializeEnvelope(payload.envelope)) !== payload.ciphertextDigest) {
    return { response: json({ error: "Encrypted backup request is invalid." }, 400) };
  }
  return { payload };
}

const READ_SQL = `
  SELECT ciphertext, revision, ciphertext_digest
  FROM dialogmint_vault_snapshots
  WHERE account_id = $1 AND expires_at > now()
`;

const WRITE_SQL = `
  WITH updated AS (
    UPDATE dialogmint_vault_snapshots
    SET format_version = $2,
        schema_version = $3,
        revision = revision + 1,
        ciphertext = $4,
        ciphertext_digest = $5,
        encrypted_bytes = $6,
        updated_at = now(),
        expires_at = now() + interval '90 days'
    WHERE account_id = $1 AND revision = $7
    RETURNING revision, ciphertext_digest
  ), inserted AS (
    INSERT INTO dialogmint_vault_snapshots (
      account_id, format_version, schema_version, revision, ciphertext, ciphertext_digest, encrypted_bytes, expires_at
    )
    SELECT $1, $2, $3, 1, $4, $5, $6, now() + interval '90 days'
    WHERE $7 = 0
    ON CONFLICT (account_id) DO NOTHING
    RETURNING revision, ciphertext_digest
  )
  SELECT revision, ciphertext_digest FROM updated
  UNION ALL
  SELECT revision, ciphertext_digest FROM inserted
`;

export async function handleVaultRequest(request, env, url, identity, options = {}) {
  if (url.pathname !== "/api/vault") return null;
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed." }, 403);
  const binding = resolveVaultBinding(url.hostname, env);
  if (!binding || identity?.environment !== expectedEnvironment(url.hostname) || !HEX_DIGEST.test(identity?.accountId ?? "")) {
    return json({ error: "Encrypted backup is unavailable." }, 503);
  }

  if (request.method === "GET") {
    try {
      const result = await queryDatabase(binding, READ_SQL, [identity.accountId], options);
      const row = result?.rows?.[0];
      if (!row) return json({ error: "Encrypted backup not found." }, 404);
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision <= 0 || !HEX_DIGEST.test(row.ciphertext_digest ?? "") ||
          !validEnvelope(row.ciphertext) || await sha256Hex(serializeEnvelope(row.ciphertext)) !== row.ciphertext_digest) {
        throw new Error("Invalid stored row");
      }
      return json({ envelope: row.ciphertext, revision, ciphertextDigest: row.ciphertext_digest });
    } catch {
      return json({ error: "Encrypted backup is temporarily unavailable." }, 503);
    }
  }

  if (request.method === "PUT") {
    const parsed = await parseVaultWrite(request);
    if (parsed.response) return parsed.response;
    const { envelope, expectedRevision, ciphertextDigest } = parsed.payload;
    try {
      const result = await queryDatabase(binding, WRITE_SQL, [identity.accountId, 1, 10, envelope, ciphertextDigest, envelope.encryptedBytes, expectedRevision], options);
      const row = result?.rows?.[0];
      if (!row) return json({ error: "Encrypted backup changed on another device." }, 409);
      const revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision <= 0 || row.ciphertext_digest !== ciphertextDigest) throw new Error("Invalid write confirmation");
      return json({ revision, ciphertextDigest });
    } catch {
      return json({ error: "Encrypted backup is temporarily unavailable." }, 503);
    }
  }

  if (request.method === "DELETE") {
    try {
      await queryDatabase(binding, "DELETE FROM dialogmint_vault_snapshots WHERE account_id = $1", [identity.accountId], options);
      return new Response(null, { status: 204, headers: VAULT_HEADERS });
    } catch {
      return json({ error: "Encrypted backup is temporarily unavailable." }, 503);
    }
  }

  return json({ error: "Method not allowed." }, 405, { Allow: "GET, PUT, DELETE" });
}

export async function cleanupExpiredVaults(env, options = {}) {
  const result = { testing: 0, production: 0 };
  const targets = [["testing", env.NEON_TESTING], ["production", env.NEON_PRODUCTION]];
  for (const [environment, binding] of targets) {
    if (!binding?.connectionString) continue;
    try {
      const response = await queryDatabase(binding, "DELETE FROM dialogmint_vault_snapshots WHERE expires_at <= now()", [], options);
      result[environment] = Math.max(0, Number(response?.rowCount) || 0);
    } catch {
      result[environment] = 0;
    }
  }
  return result;
}
