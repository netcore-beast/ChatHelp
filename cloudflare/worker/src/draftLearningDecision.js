import { Client } from "pg";
import { digestableLearningRecord, validateLearningRecord } from "./learningPolicy.js";

const ACCOUNT_ID = /^[0-9a-f]{64}$/u;
const RECORD_ID = /^[a-z0-9-]{1,64}$/u;
const LOWER_HEX_DIGEST = /^[0-9a-f]{64}$/u;
const NOTICE_VERSION = "2026-08-09-v1";
const RETENTION_DAYS = 365;
const EVALUATION_KEYS = ["action", "goalCategory", "kind", "relationshipStage", "roleId"];
const GENERATIVE_KEYS = ["goalCategory", "kind", "privacyAttested", "provenance", "relationshipStage", "rightsAttested", "roleId", "target"];
const KNOWN_KEYS = ["company", "contactName", "profileHandle", "profileUrl"];

export class DraftDecisionRequestError extends Error {
  constructor(message = "Learning decision is invalid.", status = 400) {
    super(message);
    this.name = "DraftDecisionRequestError";
    this.status = status;
  }
}

export class DraftDecisionConflictError extends Error {
  constructor(message = "Learning decision conflicts with its current state.") {
    super(message);
    this.name = "DraftDecisionConflictError";
    this.status = 409;
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
  }
  return value;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requestNow(options) {
  const candidate = typeof options?.now === "function" ? options.now() : options?.now ?? new Date();
  const now = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(now.getTime())) throw new DraftDecisionRequestError();
  return now;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_write_confirmation");
  return date.toISOString();
}

export function validateDraftLearningDecision(payload, now) {
  if (!exactKeys(payload, payload?.decision?.kind === "generative" ? ["decision", "knownIdentifiers"] : ["decision"])) {
    throw new DraftDecisionRequestError();
  }
  const decision = payload.decision;
  try {
    if (decision.kind === "evaluation") {
      if (!exactKeys(decision, EVALUATION_KEYS) || !["useful", "not_useful"].includes(decision.action)) throw new Error("invalid");
      return validateLearningRecord({
        recordKind: "evaluation",
        roleId: decision.roleId,
        relationshipStage: decision.relationshipStage,
        goalCategory: decision.goalCategory,
        provenance: "human_confirmed",
        evaluationAction: decision.action,
      }, now);
    }
    if (!exactKeys(decision, GENERATIVE_KEYS) || !exactKeys(payload.knownIdentifiers, KNOWN_KEYS)) throw new Error("invalid");
    return validateLearningRecord({
      recordKind: "generative",
      roleId: decision.roleId,
      relationshipStage: decision.relationshipStage,
      goalCategory: decision.goalCategory,
      provenance: decision.provenance,
      target: decision.target,
      rightsAttested: decision.rightsAttested,
      privacyAttested: decision.privacyAttested,
    }, now, payload.knownIdentifiers);
  } catch {
    throw new DraftDecisionRequestError();
  }
}

export async function draftDecisionContentDigest(accountId, recordId, record) {
  return sha256Hex(`${accountId}\ndraft-decision-v1\n${recordId}\n${JSON.stringify(canonicalJsonValue(digestableLearningRecord(record)))}`);
}

function storedDecision(row, recordId) {
  if (!row || row.record_id !== recordId || !["evaluation", "generative"].includes(row.record_kind)
      || !LOWER_HEX_DIGEST.test(row.content_digest ?? "")) throw new Error("invalid_stored_record");
  if (row.record_kind === "evaluation") {
    if (!["useful", "not_useful"].includes(row.evaluation_action)) throw new Error("invalid_stored_record");
    return { kind: "evaluation", action: row.evaluation_action, digest: row.content_digest, updatedAt: isoTimestamp(row.updated_at) };
  }
  return { kind: "generative", digest: row.content_digest, updatedAt: isoTimestamp(row.updated_at) };
}

function decisionForRecord(record) {
  return record.recordKind === "generative" ? "authored" : record.evaluationAction;
}

function responseForStored(recordId, stored, changed) {
  return {
    recordId,
    decision: stored.kind === "generative" ? "authored" : stored.action,
    recordKind: stored.kind,
    contentDigest: stored.digest,
    changed,
    updatedAt: stored.updatedAt,
  };
}

function responseForWrite(recordId, record, digest, row) {
  const stored = storedDecision(row, recordId);
  if (stored.kind !== record.recordKind || stored.digest !== digest
      || (stored.kind === "evaluation" && stored.action !== record.evaluationAction)) {
    throw new Error("invalid_write_confirmation");
  }
  return responseForStored(recordId, stored, true);
}

function recordValues(accountId, recordId, record, digest, now, expiresAt) {
  return [
    accountId,
    recordId,
    record.recordKind,
    record.schemaVersion,
    record.roleId,
    record.relationshipStage,
    record.goalCategory,
    record.recordKind === "evaluation" ? record.evaluationAction : null,
    record.recordKind === "generative" ? record.target : null,
    record.provenance,
    record.recordKind === "generative" ? record.rightsAttestedAt : null,
    record.recordKind === "generative" ? record.privacyAttestedAt : null,
    digest,
    now,
    expiresAt,
  ];
}

async function writeDecision(query, mode, values) {
  const statement = mode === "insert" ? `
    INSERT INTO dialogmint_learning_records (
      account_id, record_id, record_kind, schema_version, role_id, relationship_stage, goal_category,
      classifier_features, evaluation_action, target_text, provenance, rights_attested_at,
      privacy_attested_at, content_digest, enabled, created_at, updated_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, $13, true, $14, $14, $15)
    RETURNING record_id, record_kind, evaluation_action, content_digest, updated_at
  ` : `
    UPDATE dialogmint_learning_records
    SET record_kind = $3,
        schema_version = $4,
        role_id = $5,
        relationship_stage = $6,
        goal_category = $7,
        classifier_features = NULL,
        evaluation_action = $8,
        target_text = $9,
        provenance = $10,
        rights_attested_at = $11,
        privacy_attested_at = $12,
        content_digest = $13,
        enabled = true,
        created_at = $14,
        updated_at = $14,
        expires_at = $15
    WHERE account_id = $1 AND record_id = $2
    RETURNING record_id, record_kind, evaluation_action, content_digest, updated_at
  `;
  const result = await query(statement, values);
  return result?.rows?.[0];
}

async function withDecisionTransaction(binding, options, operation) {
  const client = typeof options?.createClient === "function"
    ? options.createClient(binding)
    : new Client({ connectionString: binding.connectionString });
  let started = false;
  try {
    await client.connect();
    await client.query("BEGIN");
    started = true;
    const result = await operation((text, values = []) => client.query(text, values));
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function putDraftLearningDecision(binding, accountId, recordId, payload, options = {}) {
  if (!binding || !ACCOUNT_ID.test(accountId ?? "") || !RECORD_ID.test(recordId ?? "")) throw new DraftDecisionRequestError();
  const now = requestNow(options);
  const record = validateDraftLearningDecision(payload, now);
  const digest = await draftDecisionContentDigest(accountId, recordId, record);
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const requestedDecision = decisionForRecord(record);

  return withDecisionTransaction(binding, options, async (query) => {
    const preference = await query(`
      INSERT INTO dialogmint_learning_preferences (
        account_id, enabled, notice_version, retention_days, auto_enabled_at, disabled_at, updated_at
      ) VALUES ($1, true, '${NOTICE_VERSION}', ${RETENTION_DAYS}, $2, NULL, $2)
      ON CONFLICT (account_id) DO UPDATE
      SET account_id = dialogmint_learning_preferences.account_id
      RETURNING enabled
    `, [accountId, nowIso]);
    if (preference?.rows?.[0]?.enabled !== true) throw new DraftDecisionConflictError("Cloud learning is disabled.");

    const currentResult = await query(`
      SELECT record_id, record_kind, evaluation_action, target_text, content_digest, updated_at
      FROM dialogmint_learning_records
      WHERE account_id = $1 AND record_id = $2
      FOR UPDATE
    `, [accountId, recordId]);
    const currentRow = currentResult?.rows?.[0];
    if (!currentRow) {
      const written = await writeDecision(query, "insert", recordValues(accountId, recordId, record, digest, nowIso, expiresAt));
      return responseForWrite(recordId, record, digest, written);
    }

    const current = storedDecision(currentRow, recordId);
    if (current.kind === "evaluation") {
      if (requestedDecision === "authored" && current.action !== "not_useful") {
        throw new DraftDecisionConflictError();
      }
      if (requestedDecision === current.action) return responseForStored(recordId, current, false);
      const written = await writeDecision(query, "update", recordValues(accountId, recordId, record, digest, nowIso, expiresAt));
      return responseForWrite(recordId, record, digest, written);
    }

    if (requestedDecision === "useful") return responseForStored(recordId, current, false);
    if (requestedDecision === "authored" && current.digest === digest) return responseForStored(recordId, current, false);
    throw new DraftDecisionConflictError();
  });
}
