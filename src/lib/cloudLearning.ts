import type { CloudLearningDeletionMarker, CloudLearningSyncEntry, PendingLearningRecord, WorkspaceData } from "./workspaceTypes";

const MAX_COUNT = 1_000_000;
const MAX_PAGE_RECORDS = 25;
const MAX_UPLOAD_RECORDS = 25;
const MAX_CURSOR_LENGTH = 512;
const MAX_DELETION_MARKERS = 1_000;
const RECORD_ID = /^[a-z0-9-]{1,64}$/u;
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
const ROLE_IDS = new Set(["human_resource", "network_marketing", "job_seeker", "socializing_networking"]);
const MESSAGE_COUNT_BUCKETS = new Set(["unknown", "low", "medium", "high"]);
const CLASSIFIER_FEATURE_KEYS = [
  "messageCountBucket",
  "hasIncomingQuestion",
  "hasNeedSignal",
  "hasPermissionSignal",
  "hasValueDiscussionSignal",
  "hasNextStepSignal",
] as const;
const EMPTY_KNOWN_IDENTIFIERS: CloudLearningKnownIdentifiers = Object.freeze({ contactName: "", company: "", profileUrl: "", profileHandle: "" });

export interface CloudLearningStatus {
  enabled: boolean;
  noticeVersion: string;
  retentionDays: number;
  counts: {
    classifier: number;
    evaluation: number;
    generative: number;
  };
}

interface CloudLearningRecordBase {
  recordId: string;
  roleId: "human_resource" | "network_marketing" | "job_seeker" | "socializing_networking";
  relationshipStage: keyof typeof GOAL_CATEGORY_BY_STAGE;
  goalCategory: (typeof GOAL_CATEGORY_BY_STAGE)[keyof typeof GOAL_CATEGORY_BY_STAGE];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CloudClassifierFeatures {
  messageCountBucket: "unknown" | "low" | "medium" | "high";
  hasIncomingQuestion: boolean;
  hasNeedSignal: boolean;
  hasPermissionSignal: boolean;
  hasValueDiscussionSignal: boolean;
  hasNextStepSignal: boolean;
}

export type CloudLearningRecord =
  | (CloudLearningRecordBase & { recordKind: "classifier"; classifierFeatures: CloudClassifierFeatures })
  | (CloudLearningRecordBase & { recordKind: "evaluation"; evaluationAction: "useful" | "not_useful" | "accepted" | "edited" | "rejected" })
  | (CloudLearningRecordBase & { recordKind: "generative"; target: string });

export interface CloudLearningRecordPage {
  records: CloudLearningRecord[];
  nextCursor: string | null;
}

export interface CloudLearningAcknowledgement {
  recordId: string;
  contentDigest: string;
}

export interface CloudLearningUploadResult {
  accepted: CloudLearningAcknowledgement[];
  duplicates: CloudLearningAcknowledgement[];
}

export interface CloudLearningKnownIdentifiers {
  contactName: string;
  company: string;
  profileUrl: string;
  profileHandle: string;
}

type UploadablePendingLearningRecord = PendingLearningRecord & { knownIdentifiers?: CloudLearningKnownIdentifiers };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

function isKnownIdentifiers(value: unknown): value is CloudLearningKnownIdentifiers {
  if (!isPlainObject(value) || !hasExactKeys(value, ["contactName", "company", "profileUrl", "profileHandle"])) return false;
  return [value.contactName, value.company, value.profileUrl, value.profileHandle]
    .every((item) => typeof item === "string" && item.length <= 2_000);
}

function parseClassifierFeatures(value: unknown): CloudClassifierFeatures {
  if (!isPlainObject(value) || !hasExactKeys(value, CLASSIFIER_FEATURE_KEYS)
      || !MESSAGE_COUNT_BUCKETS.has(String(value.messageCountBucket))
      || !CLASSIFIER_FEATURE_KEYS.slice(1).every((key) => typeof value[key] === "boolean")) return invalidResponse();
  return {
    messageCountBucket: value.messageCountBucket as CloudClassifierFeatures["messageCountBucket"],
    hasIncomingQuestion: value.hasIncomingQuestion as boolean,
    hasNeedSignal: value.hasNeedSignal as boolean,
    hasPermissionSignal: value.hasPermissionSignal as boolean,
    hasValueDiscussionSignal: value.hasValueDiscussionSignal as boolean,
    hasNextStepSignal: value.hasNextStepSignal as boolean,
  };
}

function invalidResponse(): never {
  throw new Error("DialogMint received an invalid cloud learning response.");
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))));
    return isPlainObject(decoded) && hasExactKeys(decoded, ["updatedAt", "recordId"])
      && isIsoTimestamp(decoded.updatedAt) && isRecordId(decoded.recordId);
  } catch {
    return false;
  }
}

function isAcknowledgement(value: unknown): value is CloudLearningAcknowledgement {
  return isPlainObject(value) && hasExactKeys(value, ["recordId", "contentDigest"])
    && isRecordId(value.recordId) && typeof value.contentDigest === "string" && /^[a-f0-9]{64}$/u.test(value.contentDigest);
}

async function learningFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error("Cloud learning is temporarily unavailable.");
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) return invalidResponse();
  try {
    return await response.json();
  } catch {
    invalidResponse();
  }
}

function parseStatus(value: unknown): CloudLearningStatus {
  if (!isPlainObject(value) || !hasExactKeys(value, ["enabled", "noticeVersion", "retentionDays", "counts"])
      || typeof value.enabled !== "boolean" || typeof value.noticeVersion !== "string" || !value.noticeVersion
      || typeof value.retentionDays !== "number" || !Number.isSafeInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 365
      || !isPlainObject(value.counts) || !hasExactKeys(value.counts, ["classifier", "evaluation", "generative"])
      || !isBoundedCount(value.counts.classifier) || !isBoundedCount(value.counts.evaluation) || !isBoundedCount(value.counts.generative)) {
    return invalidResponse();
  }
  return {
    enabled: value.enabled,
    noticeVersion: value.noticeVersion,
    retentionDays: value.retentionDays,
    counts: {
      classifier: value.counts.classifier,
      evaluation: value.counts.evaluation,
      generative: value.counts.generative,
    },
  };
}

function parseRecord(value: unknown): CloudLearningRecord {
  if (!isPlainObject(value) || !isRecordId(value.recordId) || !ROLE_IDS.has(String(value.roleId))
      || typeof value.relationshipStage !== "string" || !Object.hasOwn(GOAL_CATEGORY_BY_STAGE, value.relationshipStage)
      || value.goalCategory !== GOAL_CATEGORY_BY_STAGE[value.relationshipStage as keyof typeof GOAL_CATEGORY_BY_STAGE]
      || typeof value.enabled !== "boolean" || !isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt) || !isIsoTimestamp(value.expiresAt)) {
    return invalidResponse();
  }
  const base: CloudLearningRecordBase = {
    recordId: value.recordId as string,
    roleId: value.roleId as CloudLearningRecordBase["roleId"],
    relationshipStage: value.relationshipStage as CloudLearningRecordBase["relationshipStage"],
    goalCategory: value.goalCategory as CloudLearningRecordBase["goalCategory"],
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
  };
  if (value.recordKind === "classifier" && hasExactKeys(value, [...Object.keys(base), "recordKind", "classifierFeatures"])) {
    return { ...base, recordKind: "classifier", classifierFeatures: parseClassifierFeatures(value.classifierFeatures) };
  }
  if (value.recordKind === "evaluation" && hasExactKeys(value, [...Object.keys(base), "recordKind", "evaluationAction"])
      && ["useful", "not_useful", "accepted", "edited", "rejected"].includes(String(value.evaluationAction))) {
    return { ...base, recordKind: "evaluation", evaluationAction: value.evaluationAction as "useful" | "not_useful" | "accepted" | "edited" | "rejected" };
  }
  if (value.recordKind === "generative" && hasExactKeys(value, [...Object.keys(base), "recordKind", "target"])
      && typeof value.target === "string" && value.target.length > 0 && value.target.length <= 2_000) {
    return { ...base, recordKind: "generative", target: value.target };
  }
  return invalidResponse();
}

function parseRecordPage(value: unknown): CloudLearningRecordPage {
  if (!isPlainObject(value) || !hasExactKeys(value, ["records", "nextCursor"]) || !Array.isArray(value.records)
      || value.records.length > MAX_PAGE_RECORDS || value.nextCursor !== null && !isCursor(value.nextCursor)) return invalidResponse();
  const records = value.records.map(parseRecord);
  if (new Set(records.map((record) => record.recordId)).size !== records.length) return invalidResponse();
  return { records, nextCursor: value.nextCursor };
}

function parseUploadResult(value: unknown, requestedIds: ReadonlySet<string>): CloudLearningUploadResult {
  if (!isPlainObject(value) || !hasExactKeys(value, ["accepted", "duplicates"])
      || !Array.isArray(value.accepted) || !Array.isArray(value.duplicates)
      || value.accepted.length + value.duplicates.length > requestedIds.size) return invalidResponse();
  const acknowledgements = [...value.accepted, ...value.duplicates];
  if (!acknowledgements.every(isAcknowledgement)
      || acknowledgements.some((item) => !requestedIds.has(item.recordId))
      || new Set(acknowledgements.map((item) => item.recordId)).size !== acknowledgements.length) return invalidResponse();
  return {
    accepted: value.accepted,
    duplicates: value.duplicates,
  };
}

export async function readCloudLearningStatus(): Promise<CloudLearningStatus> {
  return parseStatus(await learningFetch("/api/learning/status", { method: "GET" }));
}

export async function readCloudLearningRecords(cursor?: string): Promise<CloudLearningRecordPage> {
  if (cursor !== undefined && !isCursor(cursor)) throw new Error("Cloud learning cursor is invalid.");
  const path = cursor ? `/api/learning/records?cursor=${encodeURIComponent(cursor)}` : "/api/learning/records";
  return parseRecordPage(await learningFetch(path, { method: "GET" }));
}

export async function updateCloudLearningPreference(enabled: boolean): Promise<{ enabled: boolean }> {
  if (typeof enabled !== "boolean") throw new Error("Cloud learning preference is invalid.");
  const response = await learningFetch("/api/learning/preference", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!isPlainObject(response) || !hasExactKeys(response, ["enabled"]) || typeof response.enabled !== "boolean") return invalidResponse();
  return { enabled: response.enabled };
}

export async function deleteCloudLearningRecord(recordId: string): Promise<{ deleted: boolean; recordId: string }> {
  if (!isRecordId(recordId)) throw new Error("Cloud learning record is invalid.");
  const response = await learningFetch(`/api/learning/records/${recordId}`, { method: "DELETE" });
  if (!isPlainObject(response) || !hasExactKeys(response, ["deleted", "recordId"])
      || typeof response.deleted !== "boolean" || response.recordId !== recordId) return invalidResponse();
  return { deleted: response.deleted, recordId };
}

export async function disableAndDeleteCloudLearning(): Promise<{ enabled: false; deleted: number }> {
  const response = await learningFetch("/api/learning", { method: "DELETE" });
  if (!isPlainObject(response) || !hasExactKeys(response, ["enabled", "deleted"])
      || response.enabled !== false || !isBoundedCount(response.deleted)) return invalidResponse();
  return { enabled: false, deleted: response.deleted };
}

function withLearningDeletionMarkers(workspace: WorkspaceData, markers: readonly CloudLearningDeletionMarker[]): WorkspaceData {
  const merged = new Map(workspace.cloudLearningDeletionMarkers.map((marker) => [marker.recordId, marker]));
  for (const marker of markers) {
    const current = merged.get(marker.recordId);
    if (!current
        || current.disposition === "deleted" && marker.disposition === "deleted" && Date.parse(marker.deletedAt) > Date.parse(current.deletedAt)
        || current.disposition !== "deleted" && (marker.disposition === "deleted" || Date.parse(marker.deletedAt) > Date.parse(current.deletedAt))) merged.set(marker.recordId, marker);
  }
  const cloudLearningDeletionMarkers = [...merged.values()].sort((left, right) => Date.parse(left.deletedAt) - Date.parse(right.deletedAt)
    || left.recordId.localeCompare(right.recordId)
    || left.disposition.localeCompare(right.disposition)
    || left.sourceCollection.localeCompare(right.sourceCollection)
    || left.sourceLocalId.localeCompare(right.sourceLocalId)).slice(-MAX_DELETION_MARKERS);
  return { ...workspace, cloudLearningDeletionMarkers };
}

export function clearDisabledCloudLearningState(workspace: WorkspaceData, now = new Date()): WorkspaceData {
  const clearedAt = now.toISOString();
  return {
    ...workspace,
    personalLearning: { enabled: false },
    feedback: workspace.feedback.filter((item) => !item.eligibleForRetrieval),
    stageTrainingRecords: [],
    pendingLearningRecords: [],
    cloudLearningSync: [],
    cloudLearningClearedAt: Date.parse(workspace.cloudLearningClearedAt) > Date.parse(clearedAt)
      ? new Date(Date.parse(workspace.cloudLearningClearedAt)).toISOString()
      : clearedAt,
  };
}

export function clearDeletedCloudLearningSyncMetadata(workspace: WorkspaceData, recordId: string, now = new Date()): WorkspaceData {
  if (!isRecordId(recordId)) return workspace;
  const pending = workspace.pendingLearningRecords.find((item) => item.recordId === recordId);
  const pendingLearningRecords = workspace.pendingLearningRecords.filter((item) => item.recordId !== recordId);
  const sourceStillReferenced = Boolean(pending && pendingLearningRecords.some((item) => item.sourceCollection === pending.sourceCollection
    && item.sourceLocalId === pending.sourceLocalId));
  return withLearningDeletionMarkers({
    ...workspace,
    feedback: pending?.sourceCollection === "feedback" && !sourceStillReferenced
      ? workspace.feedback.filter((item) => item.id !== pending.sourceLocalId)
      : workspace.feedback,
    stageTrainingRecords: pending?.sourceCollection === "stageTrainingRecords" && !sourceStillReferenced
      ? workspace.stageTrainingRecords.filter((item) => item.id !== pending.sourceLocalId)
      : workspace.stageTrainingRecords,
    pendingLearningRecords,
    cloudLearningSync: workspace.cloudLearningSync.filter((item) => item.recordId !== recordId),
  }, [{
    recordId,
    disposition: "deleted",
    sourceCollection: pending?.sourceCollection ?? "",
    sourceLocalId: pending?.sourceLocalId ?? "",
    deletedAt: now.toISOString(),
  }]);
}

export async function uploadCloudLearningRecords(records: readonly UploadablePendingLearningRecord[]): Promise<CloudLearningUploadResult> {
  if (records.length > MAX_UPLOAD_RECORDS || new Set(records.map((record) => record.recordId)).size !== records.length
      || records.some((record) => !isRecordId(record.recordId) || !isPlainObject(record.sanitizedPayload)
        || (record.recordKind === "generative"
          ? record.knownIdentifiers !== undefined && !isKnownIdentifiers(record.knownIdentifiers)
          : record.knownIdentifiers !== undefined))) {
    throw new Error("Cloud learning records are invalid.");
  }
  const payload = {
    records: records.map(({ recordId, recordKind, sanitizedPayload, knownIdentifiers }) => {
      const record = { ...sanitizedPayload };
      delete record.sourceCollection;
      delete record.sourceLocalId;
      return recordKind === "generative" ? { recordId, record, knownIdentifiers: knownIdentifiers ?? EMPTY_KNOWN_IDENTIFIERS } : { recordId, record };
    }),
  };
  const result = await learningFetch("/api/learning/records", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseUploadResult(result, new Set(records.map((record) => record.recordId)));
}

function synchronizeAcknowledgedRecords(workspace: WorkspaceData, acknowledgements: readonly CloudLearningAcknowledgement[], updatedAt: string): WorkspaceData {
  const acknowledgementsById = new Map(acknowledgements.map((acknowledgement) => [acknowledgement.recordId, acknowledgement]));
  const removed = workspace.pendingLearningRecords.filter((record) => acknowledgementsById.has(record.recordId));
  if (!removed.length) return workspace;
  const pendingLearningRecords = workspace.pendingLearningRecords.filter((record) => !acknowledgementsById.has(record.recordId));
  const retainedSources = new Set(pendingLearningRecords.map((record) => `${record.sourceCollection}\u0000${record.sourceLocalId}`));
  const removableSources = new Set(removed
    .map((record) => `${record.sourceCollection}\u0000${record.sourceLocalId}`)
    .filter((source) => !retainedSources.has(source)));
  const keepSource = (sourceCollection: "feedback" | "stageTrainingRecords", sourceLocalId: string) => !removableSources.has(`${sourceCollection}\u0000${sourceLocalId}`);
  const cloudLearningSync = [
    ...workspace.cloudLearningSync.filter((entry) => !acknowledgementsById.has(entry.recordId)),
    ...acknowledgements.map<CloudLearningSyncEntry>((acknowledgement) => ({ ...acknowledgement, status: "synced", updatedAt })),
  ];
  return withLearningDeletionMarkers({
    ...workspace,
    feedback: workspace.feedback.filter((item) => keepSource("feedback", item.id)),
    stageTrainingRecords: workspace.stageTrainingRecords.filter((item) => keepSource("stageTrainingRecords", item.id)),
    pendingLearningRecords,
    cloudLearningSync,
  }, removed.map((record) => ({
    recordId: record.recordId,
    disposition: "acknowledged",
    sourceCollection: record.sourceCollection,
    sourceLocalId: record.sourceLocalId,
    deletedAt: updatedAt,
  })));
}

function sameLearningDeletionMarker(left: CloudLearningDeletionMarker | undefined, right: CloudLearningDeletionMarker): boolean {
  return Boolean(left)
    && left?.disposition === right.disposition
    && left.sourceCollection === right.sourceCollection
    && left.sourceLocalId === right.sourceLocalId
    && left.deletedAt === right.deletedAt;
}

export function applyCloudLearningSyncDelta(latest: WorkspaceData, baseline: WorkspaceData, synced: WorkspaceData): WorkspaceData {
  const baselineMarkers = new Map(baseline.cloudLearningDeletionMarkers.map((marker) => [marker.recordId, marker]));
  const deltaMarkers = synced.cloudLearningDeletionMarkers.filter((marker) => !sameLearningDeletionMarker(baselineMarkers.get(marker.recordId), marker));
  if (!deltaMarkers.length) return latest;

  const acknowledgedIds = new Set(deltaMarkers.map((marker) => marker.recordId));
  const pendingLearningRecords = latest.pendingLearningRecords.filter((record) => !acknowledgedIds.has(record.recordId));
  const retainedSources = new Set(pendingLearningRecords.map((record) => `${record.sourceCollection}\u0000${record.sourceLocalId}`));
  const removableSources = new Set(deltaMarkers
    .filter((marker) => marker.sourceCollection && marker.sourceLocalId)
    .map((marker) => `${marker.sourceCollection}\u0000${marker.sourceLocalId}`)
    .filter((source) => !retainedSources.has(source)));
  const withMarkers = withLearningDeletionMarkers(latest, deltaMarkers);
  const deletedIds = new Set(withMarkers.cloudLearningDeletionMarkers.filter((marker) => marker.disposition === "deleted").map((marker) => marker.recordId));
  const clearedAt = Date.parse(latest.cloudLearningClearedAt);
  const acknowledgedSync = synced.cloudLearningSync.filter((entry) => acknowledgedIds.has(entry.recordId)
    && !deletedIds.has(entry.recordId)
    && (!Number.isFinite(clearedAt) || Date.parse(entry.updatedAt) > clearedAt));
  const acknowledgedSyncIds = new Set(acknowledgedSync.map((entry) => entry.recordId));

  return {
    ...withMarkers,
    feedback: latest.feedback.filter((item) => !removableSources.has(`feedback\u0000${item.id}`)),
    stageTrainingRecords: latest.stageTrainingRecords.filter((item) => !removableSources.has(`stageTrainingRecords\u0000${item.id}`)),
    pendingLearningRecords,
    cloudLearningSync: [...latest.cloudLearningSync.filter((entry) => !acknowledgedSyncIds.has(entry.recordId) && !deletedIds.has(entry.recordId)), ...acknowledgedSync],
  };
}

export async function syncPendingLearningRecords(workspace: WorkspaceData, now = new Date()): Promise<WorkspaceData> {
  let next = workspace;
  for (let index = 0; index < workspace.pendingLearningRecords.length; index += MAX_UPLOAD_RECORDS) {
    const batch = next.pendingLearningRecords.slice(0, MAX_UPLOAD_RECORDS);
    if (!batch.length) break;
    let result: CloudLearningUploadResult;
    try {
      result = await uploadCloudLearningRecords(batch);
    } catch {
      return next;
    }
    const acknowledgements = [...result.accepted, ...result.duplicates];
    next = synchronizeAcknowledgedRecords(next, acknowledgements, now.toISOString());
    if (acknowledgements.length !== batch.length) return next;
  }
  return next;
}
