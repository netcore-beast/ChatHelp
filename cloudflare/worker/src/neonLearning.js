import { Client } from "pg";
import { digestableLearningRecord, goalCategoryForStage, validateLearningRecord } from "./learningPolicy.js";
import { queryNeon, resolveNeonContext } from "./neonDb.js";

const NOTICE_VERSION = "2026-08-09-v1";
const RETENTION_DAYS = 365;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_BATCH_RECORDS = 25;
const PAGE_SIZE = 25;
const RECORD_ID = /^[a-z0-9-]{1,64}$/u;
const ACCOUNT_ID = /^[0-9a-f]{64}$/u;
const LOWER_HEX_DIGEST = /^[0-9a-f]{64}$/u;
const ROLE_IDS = new Set(["human_resource", "network_marketing", "job_seeker", "socializing_networking"]);

const LEARNING_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

class LearningRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "LearningRequestError";
    this.status = status;
  }
}

function noStoreJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...LEARNING_HEADERS, ...extraHeaders },
  });
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requestNow(options) {
  const candidate = typeof options?.now === "function" ? options.now() : options?.now ?? new Date();
  const now = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(now.getTime())) throw new LearningRequestError("Learning request is invalid.");
  return now;
}

async function queryDatabase(binding, text, values, options) {
  if (typeof options?.query === "function") return options.query(binding, text, values);
  return queryNeon(binding, text, values);
}

async function withDatabaseTransaction(binding, options, operation) {
  const client = typeof options?.createClient === "function"
    ? options.createClient(binding)
    : new Client({ connectionString: binding.connectionString });
  let transactionStarted = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await operation((text, values = []) => client.query(text, values));
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function mediaType(request) {
  return request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
}

async function readStrictJson(request) {
  if (mediaType(request) !== "application/json") throw new LearningRequestError("Expected a JSON request.", 415);
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new LearningRequestError("Learning request is too large.", 413);
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new LearningRequestError("Learning request is invalid.");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new LearningRequestError("Learning request is too large.", 413);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new LearningRequestError("Learning request is invalid.");
  }
}

function safeCount(value) {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_stored_timestamp");
  return date.toISOString();
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
  }
  return value;
}

async function contentDigest(accountId, record) {
  return sha256Hex(`${accountId}\n${JSON.stringify(canonicalJsonValue(digestableLearningRecord(record)))}`);
}

function parseCursor(value) {
  if (value === null) return { updatedAt: null, recordId: null };
  if (typeof value !== "string" || !value || value.length > 512) throw new LearningRequestError("Learning cursor is invalid.");
  try {
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), (character) => character.charCodeAt(0))));
    if (!exactKeys(decoded, ["updatedAt", "recordId"]) || typeof decoded.updatedAt !== "string" || !RECORD_ID.test(decoded.recordId)) throw new Error("invalid");
    const updatedAt = isoTimestamp(decoded.updatedAt);
    if (updatedAt !== decoded.updatedAt) throw new Error("invalid");
    return { updatedAt, recordId: decoded.recordId };
  } catch {
    throw new LearningRequestError("Learning cursor is invalid.");
  }
}

function encodeCursor(updatedAt, recordId) {
  const bytes = new TextEncoder().encode(JSON.stringify({ updatedAt: isoTimestamp(updatedAt), recordId }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function readLearningStatus(binding, accountId, _environment, options) {
  const now = requestNow(options).toISOString();
  const result = await queryDatabase(binding, `
    SELECT
      (SELECT enabled FROM dialogmint_learning_preferences WHERE account_id = $1) AS enabled,
      count(*) FILTER (WHERE record_kind = 'classifier') AS classifier_count,
      count(*) FILTER (WHERE record_kind = 'evaluation') AS evaluation_count,
      count(*) FILTER (WHERE record_kind = 'generative') AS generative_count
    FROM dialogmint_learning_records
    WHERE account_id = $1 AND expires_at > $2
  `, [accountId, now], options);
  const row = result?.rows?.[0] ?? {};
  return {
    enabled: row.enabled !== false,
    noticeVersion: NOTICE_VERSION,
    retentionDays: RETENTION_DAYS,
    counts: {
      classifier: safeCount(row.classifier_count),
      evaluation: safeCount(row.evaluation_count),
      generative: safeCount(row.generative_count),
    },
  };
}

async function listLearningRecords(binding, accountId, searchParams, options) {
  const keys = [...searchParams.keys()];
  if (keys.some((key) => key !== "cursor") || searchParams.getAll("cursor").length > 1) {
    throw new LearningRequestError("Learning query is invalid.");
  }
  const cursor = parseCursor(searchParams.get("cursor"));
  const now = requestNow(options).toISOString();
  const result = await queryDatabase(binding, `
    SELECT record_id, record_kind, role_id, relationship_stage, goal_category,
           evaluation_action, target_text, enabled, created_at, updated_at, expires_at
    FROM dialogmint_learning_records
    WHERE account_id = $1
      AND expires_at > $5
      AND ($2::timestamptz IS NULL OR updated_at < $2::timestamptz OR (updated_at = $2::timestamptz AND record_id > $3))
    ORDER BY updated_at DESC, record_id ASC
    LIMIT $4
  `, [accountId, cursor.updatedAt, cursor.recordId, PAGE_SIZE + 1, now], options);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const page = rows.slice(0, PAGE_SIZE);
  const records = page.map((row) => {
    if (!RECORD_ID.test(row.record_id ?? "") || !["classifier", "evaluation", "generative"].includes(row.record_kind)
        || !ROLE_IDS.has(row.role_id) || goalCategoryForStage(row.relationship_stage) !== row.goal_category
        || typeof row.enabled !== "boolean") throw new Error("invalid_stored_record");
    const record = {
      recordId: row.record_id,
      recordKind: row.record_kind,
      roleId: row.role_id,
      relationshipStage: row.relationship_stage,
      goalCategory: row.goal_category,
      enabled: row.enabled,
      createdAt: isoTimestamp(row.created_at),
      updatedAt: isoTimestamp(row.updated_at),
      expiresAt: isoTimestamp(row.expires_at),
    };
    if (row.record_kind === "evaluation") {
      if (typeof row.evaluation_action !== "string") throw new Error("invalid_stored_record");
      return { ...record, evaluationAction: row.evaluation_action };
    }
    if (row.record_kind === "generative") {
      if (typeof row.target_text !== "string" || !row.target_text) throw new Error("invalid_stored_record");
      return { ...record, target: row.target_text };
    }
    return record;
  });
  const last = page.at(-1);
  return {
    records,
    nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.updated_at, last.record_id) : null,
  };
}

async function setLearningPreference(binding, accountId, payload, options) {
  if (!exactKeys(payload, ["enabled"]) || typeof payload.enabled !== "boolean") {
    throw new LearningRequestError("Learning preference is invalid.");
  }
  const now = requestNow(options).toISOString();
  await withDatabaseTransaction(binding, options, async (query) => {
    await query(`
      INSERT INTO dialogmint_learning_preferences (
        account_id, enabled, notice_version, retention_days, auto_enabled_at, disabled_at, updated_at
      ) VALUES ($1, $2, '${NOTICE_VERSION}', ${RETENTION_DAYS}, $3, CASE WHEN $2 THEN NULL ELSE $3::timestamptz END, $3)
      ON CONFLICT (account_id) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          notice_version = EXCLUDED.notice_version,
          retention_days = EXCLUDED.retention_days,
          disabled_at = EXCLUDED.disabled_at,
          updated_at = EXCLUDED.updated_at
      RETURNING enabled
    `, [accountId, payload.enabled, now]);
    await query(`
    UPDATE dialogmint_learning_records
    SET enabled = $2, updated_at = $3
    WHERE account_id = $1
    `, [accountId, payload.enabled, now]);
  });
  return { enabled: payload.enabled };
}

function validateBatch(payload, now) {
  if (!exactKeys(payload, ["records"]) || !Array.isArray(payload.records) || payload.records.length > MAX_BATCH_RECORDS) {
    throw new LearningRequestError("Learning records are invalid.");
  }
  const recordIds = new Set();
  return payload.records.map((item) => {
    const isGenerative = item?.record?.recordKind === "generative";
    const expectedKeys = isGenerative ? ["recordId", "record", "knownIdentifiers"] : ["recordId", "record"];
    if (!exactKeys(item, expectedKeys) || !RECORD_ID.test(item.recordId) || recordIds.has(item.recordId)) {
      throw new LearningRequestError("Learning records are invalid.");
    }
    recordIds.add(item.recordId);
    try {
      return {
        recordId: item.recordId,
        record: validateLearningRecord(item.record, now, isGenerative ? item.knownIdentifiers : undefined),
      };
    } catch {
      throw new LearningRequestError("Learning records are invalid.");
    }
  });
}

async function putLearningRecords(binding, accountId, payload, options) {
  const now = requestNow(options);
  const records = validateBatch(payload, now);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const preference = await queryDatabase(binding, `
    WITH created AS (
      INSERT INTO dialogmint_learning_preferences (
        account_id, enabled, notice_version, retention_days, auto_enabled_at, disabled_at, updated_at
      ) VALUES ($1, true, '${NOTICE_VERSION}', ${RETENTION_DAYS}, $2, NULL, $2)
      ON CONFLICT (account_id) DO NOTHING
      RETURNING enabled
    )
    SELECT enabled FROM created
    UNION ALL
    SELECT enabled FROM dialogmint_learning_preferences WHERE account_id = $1
    LIMIT 1
  `, [accountId, nowIso], options);
  if (preference?.rows?.[0]?.enabled === false) throw new LearningRequestError("Cloud learning is disabled.", 409);

  const accepted = [];
  const duplicates = [];
  for (const item of records) {
    const record = item.record;
    const digest = await contentDigest(accountId, record);
    const result = await queryDatabase(binding, `
      WITH preference AS MATERIALIZED (
        SELECT enabled
        FROM dialogmint_learning_preferences
        WHERE account_id = $1
        FOR UPDATE
      ), inserted AS (
        INSERT INTO dialogmint_learning_records (
          account_id, record_id, record_kind, schema_version, role_id, relationship_stage, goal_category,
          classifier_features, evaluation_action, target_text, provenance, rights_attested_at,
          privacy_attested_at, content_digest, enabled, created_at, updated_at, expires_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15, $15, $16
        WHERE EXISTS (SELECT 1 FROM preference WHERE enabled = true)
        ON CONFLICT DO NOTHING
        RETURNING record_id, content_digest, true AS inserted
      )
      SELECT record_id, content_digest, inserted, true AS id_match, true AS preference_enabled FROM inserted
      UNION ALL
      SELECT record_id, content_digest, false AS inserted, (record_id = $2) AS id_match, true AS preference_enabled
      FROM dialogmint_learning_records
      WHERE account_id = $1 AND (record_id = $2 OR content_digest = $14)
        AND EXISTS (SELECT 1 FROM preference WHERE enabled = true)
        AND NOT EXISTS (SELECT 1 FROM inserted)
      UNION ALL
      SELECT NULL::varchar(64), NULL::char(64), false, false, false
      WHERE NOT EXISTS (SELECT 1 FROM preference WHERE enabled = true)
      ORDER BY preference_enabled DESC, inserted DESC, id_match DESC
      LIMIT 1
    `, [
      accountId,
      item.recordId,
      record.recordKind,
      record.schemaVersion,
      record.roleId,
      record.relationshipStage,
      record.goalCategory,
      record.recordKind === "classifier" ? record.classifierFeatures : null,
      record.recordKind === "evaluation" ? record.evaluationAction : null,
      record.recordKind === "generative" ? record.target : null,
      record.provenance,
      record.recordKind === "generative" ? record.rightsAttestedAt : null,
      record.recordKind === "generative" ? record.privacyAttestedAt : null,
      digest,
      nowIso,
      expiresAt,
    ], options);
    const row = result?.rows?.[0];
    if (row?.preference_enabled === false) throw new LearningRequestError("Cloud learning is disabled.", 409);
    if (!row || !LOWER_HEX_DIGEST.test(row.content_digest ?? "")) throw new Error("invalid_write_confirmation");
    if (row.content_digest !== digest) throw new LearningRequestError("Learning record ID is already in use.", 409);
    const acknowledgement = { recordId: item.recordId, contentDigest: digest };
    (row.inserted === true ? accepted : duplicates).push(acknowledgement);
  }
  return { accepted, duplicates };
}

async function deleteLearningRecord(binding, accountId, recordId, options) {
  const result = await queryDatabase(binding, `
    DELETE FROM dialogmint_learning_records
    WHERE account_id = $1 AND record_id = $2
  `, [accountId, recordId], options);
  return { deleted: safeCount(result?.rowCount) > 0, recordId };
}

async function disableAndDeleteLearning(binding, accountId, options) {
  const now = requestNow(options).toISOString();
  const deleted = await withDatabaseTransaction(binding, options, async (query) => {
    await query(`
      INSERT INTO dialogmint_learning_preferences (
        account_id, enabled, notice_version, retention_days, auto_enabled_at, disabled_at, updated_at
      ) VALUES ($1, false, '${NOTICE_VERSION}', ${RETENTION_DAYS}, $2, $2, $2)
      ON CONFLICT (account_id) DO UPDATE
      SET enabled = false,
          notice_version = EXCLUDED.notice_version,
          retention_days = EXCLUDED.retention_days,
          disabled_at = EXCLUDED.disabled_at,
          updated_at = EXCLUDED.updated_at
      RETURNING account_id
    `, [accountId, now]);
    const result = await query("DELETE FROM dialogmint_learning_records WHERE account_id = $1", [accountId]);
    return safeCount(result?.rowCount);
  });
  return { enabled: false, deleted };
}

function learningErrorResponse(error) {
  if (error instanceof LearningRequestError) return noStoreJson({ error: error.message }, error.status);
  return noStoreJson({ error: "Cloud learning is temporarily unavailable." }, 503);
}

export async function handleLearningRequest(request, env, url, identity, options = {}) {
  if (!/^\/api\/learning(?:\/|$)/u.test(url.pathname)) return null;
  let neonContext;
  try {
    neonContext = resolveNeonContext(env, url.hostname);
  } catch {
    return noStoreJson({ error: "Cloud learning is unavailable." }, 503);
  }
  if (identity?.environment !== neonContext.environment || !ACCOUNT_ID.test(identity?.accountId ?? "")) {
    return noStoreJson({ error: "Cloud learning is unavailable." }, 503);
  }

  let rate;
  try {
    rate = await env.DRAFT_RATE_LIMITER.limit({ key: `learning:${identity.accountId}` });
  } catch {
    return noStoreJson({ error: "Cloud learning is temporarily unavailable." }, 503);
  }
  if (!rate?.success) return noStoreJson({ error: "Please wait before trying again." }, 429, { "Retry-After": "60" });
  if (request.headers.has("X-Account-Id") || request.headers.has("X-User-Email")) {
    return noStoreJson({ error: "Browser account identifiers are not accepted." }, 400);
  }

  const binding = neonContext.binding;
  try {
    if (!(request.method === "GET" && url.pathname === "/api/learning/records")
        && [...url.searchParams.keys()].length) throw new LearningRequestError("Learning query is invalid.");
    if (request.method === "GET" && url.pathname === "/api/learning/status") {
      return noStoreJson(await readLearningStatus(binding, identity.accountId, neonContext.environment, options));
    }
    if (request.method === "GET" && url.pathname === "/api/learning/records") {
      return noStoreJson(await listLearningRecords(binding, identity.accountId, url.searchParams, options));
    }
    if (request.method === "PUT" && url.pathname === "/api/learning/preference") {
      return noStoreJson(await setLearningPreference(binding, identity.accountId, await readStrictJson(request), options));
    }
    if (request.method === "PUT" && url.pathname === "/api/learning/records") {
      return noStoreJson(await putLearningRecords(binding, identity.accountId, await readStrictJson(request), options));
    }
    if (request.method === "DELETE" && url.pathname === "/api/learning") {
      return noStoreJson(await disableAndDeleteLearning(binding, identity.accountId, options));
    }
    const match = request.method === "DELETE" && url.pathname.match(/^\/api\/learning\/records\/([a-z0-9-]{1,64})$/u);
    return match ? noStoreJson(await deleteLearningRecord(binding, identity.accountId, match[1], options)) : null;
  } catch (error) {
    return learningErrorResponse(error);
  }
}

export async function retrieveLearningExamples(binding, accountId, query, options = {}) {
  if (!binding || !ACCOUNT_ID.test(accountId ?? "") || !exactKeys(query, ["roleId", "relationshipStage", "goalCategory"])
      || !ROLE_IDS.has(query.roleId) || goalCategoryForStage(query.relationshipStage) !== query.goalCategory) return [];
  const now = requestNow(options).toISOString();
  const preference = await queryDatabase(binding, `
    SELECT COALESCE((
      SELECT enabled FROM dialogmint_learning_preferences WHERE account_id = $1
    ), true) AS enabled
  `, [accountId], options);
  if (preference?.rows?.[0]?.enabled === false) return [];
  const result = await queryDatabase(binding, `
    SELECT role_id, relationship_stage, goal_category, target_text
    FROM dialogmint_learning_records
    WHERE account_id = $1
      AND enabled = true
      AND record_kind = 'generative'
      AND expires_at > $2
    ORDER BY (relationship_stage = $3) DESC,
             (role_id = $4) DESC,
             (goal_category = $5) DESC,
             updated_at DESC,
             record_id ASC
    LIMIT 3
  `, [accountId, now, query.relationshipStage, query.roleId, query.goalCategory], options);
  return (Array.isArray(result?.rows) ? result.rows : []).slice(0, 3).flatMap((row) => {
    if (!ROLE_IDS.has(row.role_id) || goalCategoryForStage(row.relationship_stage) !== row.goal_category
        || typeof row.target_text !== "string" || !row.target_text) return [];
    return [{
      roleId: row.role_id,
      relationshipStage: row.relationship_stage,
      goalCategory: row.goal_category,
      target: row.target_text,
    }];
  });
}

export async function cleanupExpiredLearningRecords(env, options = {}) {
  const environment = env.DEPLOYMENT_ENVIRONMENT;
  const binding = environment === "testing" ? env.NEON_TESTING : environment === "production" ? env.NEON_PRODUCTION : null;
  if (!binding?.connectionString) return 0;
  try {
    const result = await queryDatabase(binding, "DELETE FROM dialogmint_learning_records WHERE expires_at <= $1", [requestNow(options).toISOString()], options);
    return safeCount(result?.rowCount);
  } catch {
    return 0;
  }
}
