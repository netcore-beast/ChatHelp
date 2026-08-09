export const LEARNING_POLICY_VERSION = 1;

export const GOAL_CATEGORY_BY_STAGE = Object.freeze({
  new_connection: "connect",
  genuine_rapport: "build_rapport",
  learn_interests: "discover_interests",
  identify_need: "identify_need",
  ask_permission: "request_permission",
  introduce_value: "present_value",
  answer_without_pressure: "answer_questions",
  voluntary_next_step: "agree_next_step",
});

export const ROLE_ID_BY_MESSAGING_ROLE = Object.freeze({
  "Human Resource": "human_resource",
  "Network Marketing": "network_marketing",
  "Job Seeker": "job_seeker",
  "Socializing/Networking": "socializing_networking",
});

export const FORBIDDEN_IDENTIFIER_PATTERNS = Object.freeze([
  ["email_address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ["url", /\b(?:https?:\/\/|www\.)\S+/iu],
  ["social_handle", /(^|\s)@[A-Z0-9_]{2,30}\b/iu],
  ["phone_number", /(?:\+?\d[\s().-]*){8,}/u],
  ["postal_address", /\b\d{1,6}\s+[\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr)\b/iu],
  ["long_identifier", /\b\d{8,}\b/u],
  ["control_character", /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u],
]);

const ROLE_IDS = new Set(Object.values(ROLE_ID_BY_MESSAGING_ROLE));
const EVALUATION_ACTIONS = new Set(["useful", "not_useful", "accepted", "edited", "rejected"]);
const MESSAGE_COUNT_BUCKETS = new Set(["unknown", "low", "medium", "high"]);
const CLASSIFIER_FEATURE_KEYS = [
  "messageCountBucket",
  "hasIncomingQuestion",
  "hasNeedSignal",
  "hasPermissionSignal",
  "hasValueDiscussionSignal",
  "hasNextStepSignal",
];
const EMPTY_KNOWN_IDENTIFIERS = Object.freeze({ contactName: "", company: "", profileUrl: "", profileHandle: "" });

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requiredKeysForRecordKind(recordKind) {
  if (recordKind === "classifier") {
    return ["recordKind", "roleId", "relationshipStage", "goalCategory", "provenance", "classifierFeatures"];
  }
  if (recordKind === "evaluation") {
    return ["recordKind", "roleId", "relationshipStage", "goalCategory", "provenance", "evaluationAction"];
  }
  if (recordKind === "generative") {
    return ["recordKind", "roleId", "relationshipStage", "goalCategory", "provenance", "target", "rightsAttested", "privacyAttested"];
  }
  return null;
}

function normalizedText(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceKnownValue(text, known, replacement) {
  const value = normalizedText(known);
  if (!value) return text;
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_@.])${escapedRegExp(value)}(?![\\p{L}\\p{N}_@.])`, "giu"), replacement);
}

function normalizedKnownIdentifiers(known) {
  if (!known || typeof known !== "object") throw new Error("invalid_known_identifiers");
  const keys = ["contactName", "company", "profileUrl", "profileHandle"];
  if (!hasExactKeys(known, keys) || !keys.every((key) => typeof known[key] === "string")) throw new Error("invalid_known_identifiers");
  return known;
}

function validClassifierFeatures(value) {
  if (!hasExactKeys(value, CLASSIFIER_FEATURE_KEYS)) return false;
  return MESSAGE_COUNT_BUCKETS.has(value.messageCountBucket)
    && CLASSIFIER_FEATURE_KEYS.slice(1).every((key) => typeof value[key] === "boolean");
}

export function goalCategoryForStage(stage) {
  return typeof stage === "string" && Object.hasOwn(GOAL_CATEGORY_BY_STAGE, stage)
    ? GOAL_CATEGORY_BY_STAGE[stage]
    : null;
}

export function roleIdForMessagingRole(role) {
  return typeof role === "string" && Object.hasOwn(ROLE_ID_BY_MESSAGING_ROLE, role)
    ? ROLE_ID_BY_MESSAGING_ROLE[role]
    : null;
}

export function findForbiddenIdentifier(text) {
  const normalized = normalizedText(text);
  if (!normalized && typeof text !== "string") return "invalid_text";
  // A run of eight digits is an identifier even though it could also satisfy
  // the broad phone-number detector; report the more specific rejection.
  if (FORBIDDEN_IDENTIFIER_PATTERNS.find(([reason]) => reason === "long_identifier")[1].test(normalized)) return "long_identifier";
  for (const [reason, pattern] of FORBIDDEN_IDENTIFIER_PATTERNS) {
    if (reason === "long_identifier") continue;
    if (pattern.test(normalized)) return reason;
  }
  return null;
}

export function sanitizeKnownIdentifiers(text, known = {}) {
  const identifiers = normalizedKnownIdentifiers(known);
  let sanitized = normalizedText(text);
  sanitized = replaceKnownValue(sanitized, identifiers.profileUrl, "[profile]");
  sanitized = replaceKnownValue(sanitized, identifiers.profileHandle, "[profile]");
  sanitized = replaceKnownValue(sanitized, identifiers.contactName, "[contact]");
  return replaceKnownValue(sanitized, identifiers.company, "[company]");
}

export function validateLearningRecord(input, now = new Date(), known) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_record");
  const expectedKeys = requiredKeysForRecordKind(input.recordKind);
  if (!expectedKeys) throw new Error("invalid_record_kind");
  if (!hasExactKeys(input, expectedKeys)) throw new Error("unknown_key");
  if (!ROLE_IDS.has(input.roleId)) throw new Error("invalid_role_id");
  const expectedGoalCategory = goalCategoryForStage(input.relationshipStage);
  if (!expectedGoalCategory) throw new Error("invalid_relationship_stage");
  if (input.goalCategory !== expectedGoalCategory) throw new Error("goal_category_mismatch");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("invalid_clock");

  const base = {
    recordKind: input.recordKind,
    schemaVersion: LEARNING_POLICY_VERSION,
    roleId: input.roleId,
    relationshipStage: input.relationshipStage,
    goalCategory: input.goalCategory,
    provenance: input.provenance,
  };

  if (input.recordKind === "classifier") {
    if (input.provenance !== "human_confirmed") throw new Error("invalid_provenance");
    if (!validClassifierFeatures(input.classifierFeatures)) throw new Error("invalid_classifier_features");
    return { ...base, classifierFeatures: { ...input.classifierFeatures } };
  }

  if (input.recordKind === "evaluation") {
    if (input.provenance !== "human_confirmed") throw new Error("invalid_provenance");
    if (!EVALUATION_ACTIONS.has(input.evaluationAction)) throw new Error("invalid_evaluation_action");
    return { ...base, evaluationAction: input.evaluationAction };
  }

  if (input.provenance !== "independently_user_authored") throw new Error("invalid_provenance");
  if (input.rightsAttested !== true || input.privacyAttested !== true) throw new Error("missing_attestation");
  const target = sanitizeKnownIdentifiers(input.target, known);
  if (!target || target.length > 2_000) throw new Error("invalid_target");
  const forbiddenIdentifier = findForbiddenIdentifier(target);
  if (forbiddenIdentifier) throw new Error(`forbidden_identifier:${forbiddenIdentifier}`);
  const attestedAt = now.toISOString();
  return {
    ...base,
    target,
    rightsAttestedAt: attestedAt,
    privacyAttestedAt: attestedAt,
  };
}

export function digestableLearningRecord(record) {
  const validated = validateDigestableRecord(record);
  if (validated.recordKind === "classifier") {
    return {
      schemaVersion: validated.schemaVersion,
      recordKind: validated.recordKind,
      roleId: validated.roleId,
      relationshipStage: validated.relationshipStage,
      goalCategory: validated.goalCategory,
      provenance: validated.provenance,
      classifierFeatures: { ...validated.classifierFeatures },
    };
  }
  if (validated.recordKind === "evaluation") {
    return {
      schemaVersion: validated.schemaVersion,
      recordKind: validated.recordKind,
      roleId: validated.roleId,
      relationshipStage: validated.relationshipStage,
      goalCategory: validated.goalCategory,
      provenance: validated.provenance,
      evaluationAction: validated.evaluationAction,
    };
  }
  return {
    schemaVersion: validated.schemaVersion,
    recordKind: validated.recordKind,
    roleId: validated.roleId,
    relationshipStage: validated.relationshipStage,
    goalCategory: validated.goalCategory,
    provenance: validated.provenance,
    target: validated.target,
  };
}

function validateDigestableRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid_record");
  const expectedKeys = requiredKeysForRecordKind(record.recordKind);
  const persistedKeys = record.recordKind === "generative"
    ? [...expectedKeys.filter((key) => key !== "rightsAttested" && key !== "privacyAttested"), "schemaVersion", "rightsAttestedAt", "privacyAttestedAt"]
    : [...expectedKeys, "schemaVersion"];
  if (!hasExactKeys(record, persistedKeys)) throw new Error("invalid_record");
  if (record.schemaVersion !== LEARNING_POLICY_VERSION) throw new Error("invalid_schema_version");
  if (record.recordKind === "classifier") return validateLearningRecord({
    recordKind: record.recordKind,
    roleId: record.roleId,
    relationshipStage: record.relationshipStage,
    goalCategory: record.goalCategory,
    provenance: record.provenance,
    classifierFeatures: record.classifierFeatures,
  });
  if (record.recordKind === "evaluation") return validateLearningRecord({
    recordKind: record.recordKind,
    roleId: record.roleId,
    relationshipStage: record.relationshipStage,
    goalCategory: record.goalCategory,
    provenance: record.provenance,
    evaluationAction: record.evaluationAction,
  });
  const attestedAt = new Date(record.rightsAttestedAt);
  if (typeof record.rightsAttestedAt !== "string" || typeof record.privacyAttestedAt !== "string"
    || Number.isNaN(attestedAt.getTime()) || attestedAt.toISOString() !== record.rightsAttestedAt
    || record.privacyAttestedAt !== record.rightsAttestedAt) throw new Error("missing_attestation");
  return validateLearningRecord({
    recordKind: record.recordKind,
    roleId: record.roleId,
    relationshipStage: record.relationshipStage,
    goalCategory: record.goalCategory,
    provenance: record.provenance,
    target: record.target,
    rightsAttested: true,
    privacyAttested: true,
  }, attestedAt, EMPTY_KNOWN_IDENTIFIERS);
}
