import { isGenerativeTrainingEligible, normalizeFeedback } from "./personalLearning";
import { normalizeStageTrainingRecord } from "./relationshipStageClassifier";
import type { CloudClassifierFeatures, CloudLearningRecord } from "./cloudLearning";
import {
  RELATIONSHIP_STAGES,
  type RelationshipStage,
  type WorkspaceData,
} from "./workspaceTypes";

const EXPORT_SCHEMA_VERSION = 1 as const;
const MAX_ADAPTER_BYTES = 300 * 1024 * 1024;

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

const CLOUD_ROLE_IDS = new Set(["human_resource", "network_marketing", "job_seeker", "socializing_networking"]);
const CLASSIFIER_FEATURE_KEYS = [
  "messageCountBucket",
  "hasIncomingQuestion",
  "hasNeedSignal",
  "hasPermissionSignal",
  "hasValueDiscussionSignal",
  "hasNextStepSignal",
] as const;

export interface CloudTrainingExports {
  classifier: Array<{
    roleId: string;
    relationshipStage: RelationshipStage;
    goalCategory: string;
    classifierFeatures: CloudClassifierFeatures;
  }>;
  generative: Array<{
    roleId: string;
    relationshipStage: RelationshipStage;
    goalCategory: string;
    target: string;
  }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCloudRecordBase(value: Record<string, unknown>): boolean {
  return value.enabled === true
    && typeof value.roleId === "string" && CLOUD_ROLE_IDS.has(value.roleId)
    && typeof value.relationshipStage === "string" && Object.hasOwn(GOAL_CATEGORY_BY_STAGE, value.relationshipStage)
    && value.goalCategory === GOAL_CATEGORY_BY_STAGE[value.relationshipStage as RelationshipStage];
}

function classifierFeatures(value: unknown): CloudClassifierFeatures | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== CLASSIFIER_FEATURE_KEYS.length
      || !keys.every((key, index) => key === [...CLASSIFIER_FEATURE_KEYS].sort()[index])
      || !["unknown", "low", "medium", "high"].includes(String(value.messageCountBucket))
      || !CLASSIFIER_FEATURE_KEYS.slice(1).every((key) => typeof value[key] === "boolean")) return null;
  return {
    messageCountBucket: value.messageCountBucket as CloudClassifierFeatures["messageCountBucket"],
    hasIncomingQuestion: value.hasIncomingQuestion as boolean,
    hasNeedSignal: value.hasNeedSignal as boolean,
    hasPermissionSignal: value.hasPermissionSignal as boolean,
    hasValueDiscussionSignal: value.hasValueDiscussionSignal as boolean,
    hasNextStepSignal: value.hasNextStepSignal as boolean,
  };
}

export function buildCloudTrainingExports(records: readonly CloudLearningRecord[]): CloudTrainingExports {
  const classifier: CloudTrainingExports["classifier"] = [];
  const generative: CloudTrainingExports["generative"] = [];
  for (const record of records as readonly unknown[]) {
    if (!isPlainObject(record) || !isCloudRecordBase(record)) continue;
    const relationshipStage = record.relationshipStage as RelationshipStage;
    if (record.recordKind === "classifier") {
      const features = classifierFeatures(record.classifierFeatures);
      if (features) classifier.push({
        roleId: record.roleId as string,
        relationshipStage,
        goalCategory: record.goalCategory as string,
        classifierFeatures: features,
      });
    } else if (record.recordKind === "generative" && typeof record.target === "string" && record.target.trim() && record.target.length <= 2_000) {
      generative.push({
        roleId: record.roleId as string,
        relationshipStage,
        goalCategory: record.goalCategory as string,
        target: record.target,
      });
    }
  }
  const stable = (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right));
  return { classifier: classifier.sort(stable), generative: generative.sort(stable) };
}

export interface TrainingExportManifest {
  schemaVersion: 1;
  createdAt: string;
  counts: {
    classifierRecords: number;
    userAuthoredGenerativeRecords: number;
    excludedStageRecords: number;
    excludedGenerativeRecords: number;
  };
  byStage: Record<RelationshipStage, { classifier: number; generative: number }>;
  byOrigin: {
    human_confirmed: number;
    independently_user_authored: number;
  };
  exclusions: string[];
  uploadAllowed: false;
}

export interface TrainingExportBundle {
  manifest: TrainingExportManifest;
  classifierJsonl: string;
  userAuthoredGenerativeJsonl: string;
}

function emptyStageCounts(): Record<RelationshipStage, { classifier: number; generative: number }> {
  return Object.fromEntries(RELATIONSHIP_STAGES.map((stage) => [stage, { classifier: 0, generative: 0 }])) as Record<RelationshipStage, { classifier: number; generative: number }>;
}

function jsonl(values: readonly unknown[]): string {
  return values.length ? values.map((value) => JSON.stringify(value)).join("\n") + "\n" : "";
}

export function buildTrainingExportBundle(workspace: WorkspaceData, createdAt = new Date().toISOString()): TrainingExportBundle {
  const normalizedStageRecords = workspace.stageTrainingRecords.flatMap((value, index) => {
    const record = normalizeStageTrainingRecord(value, index);
    return record ? [record] : [];
  });
  const classifierLines = normalizedStageRecords
    .filter((record) => record.humanConfirmed)
    .map((record) => ({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      featureSchemaVersion: record.featureSchemaVersion,
      task: "relationship_stage_classification",
      features: {
        role: record.role,
        messageCountBucket: record.messageCountBucket,
        hasIncomingQuestion: record.hasIncomingQuestion,
        hasNeedSignal: record.hasNeedSignal,
        hasPermissionSignal: record.hasPermissionSignal,
        hasValueDiscussionSignal: record.hasValueDiscussionSignal,
        hasNextStepSignal: record.hasNextStepSignal,
        semanticTokens: record.semanticTokens,
      },
      label: record.confirmedStage,
      provenance: "human_confirmed",
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  const normalizedFeedback = workspace.feedback.flatMap((value, index) => {
    const record = normalizeFeedback(value, index);
    return record ? [record] : [];
  });
  const generativeLines = normalizedFeedback
    .filter((record) => isGenerativeTrainingEligible(record))
    .map((record) => ({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      task: "user_owned_response_example",
      input: {
        role: record.role,
        relationshipStage: record.relationshipStage,
        conversationGoal: record.conversationGoal,
      },
      target: record.preferredResponse,
      provenance: "independently_user_authored",
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  const byStage = emptyStageCounts();
  for (const line of classifierLines) byStage[line.label].classifier += 1;
  for (const line of generativeLines) byStage[line.input.relationshipStage].generative += 1;
  const manifest: TrainingExportManifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    createdAt,
    counts: {
      classifierRecords: classifierLines.length,
      userAuthoredGenerativeRecords: generativeLines.length,
      excludedStageRecords: workspace.stageTrainingRecords.length - classifierLines.length,
      excludedGenerativeRecords: workspace.feedback.length - generativeLines.length,
    },
    byStage,
    byOrigin: {
      human_confirmed: classifierLines.length,
      independently_user_authored: generativeLines.length,
    },
    exclusions: [
      "contact identifiers, names, companies, profile and conversation URLs",
      "raw messages, imported documents, notes, outcomes, and provider reasoning",
      "Claude drafts, reviewer rewrites, provider-assisted text, disabled records, and unapproved examples",
      "credentials, API keys, access data, recovery keys, and encrypted-vault material",
    ],
    uploadAllowed: false,
  };
  return { manifest, classifierJsonl: jsonl(classifierLines), userAuthoredGenerativeJsonl: jsonl(generativeLines) };
}

export interface CloudflareLoraManifestInput {
  baseModelId: string;
  reviewedSupportedBaseModels: string[];
  modelType: string;
  quantized: boolean;
  rank: number;
  task: string;
  files: Array<{ name: string; sizeBytes: number }>;
  provenance: string;
  license: string;
  approvals: { dataset: boolean; baseModel: boolean; license: boolean; cost: boolean; account: boolean };
}

export function validateCloudflareLoraManifest(input: CloudflareLoraManifestInput): { compatible: boolean; uploadAllowed: false; issues: string[] } {
  const issues: string[] = [];
  if (!input.reviewedSupportedBaseModels.includes(input.baseModelId)) issues.push("Base model is not in the reviewed supported base allowlist.");
  if (!new Set(["mistral", "gemma", "llama"]).has(input.modelType)) issues.push("model_type must be mistral, gemma, or llama.");
  if (input.quantized) issues.push("The base model must be non-quantized.");
  if (!Number.isInteger(input.rank) || input.rank < 1 || input.rank > 32) issues.push("Adapter rank must be between 1 and 32.");
  if (input.task !== "causal-lm") issues.push("The adapter task must be causal-LM.");
  const filenames = input.files.map((file) => file.name).sort();
  if (!filenames.includes("adapter_config.json")) issues.push("adapter_config.json is required.");
  if (!filenames.includes("adapter_model.safetensors")) issues.push("adapter_model.safetensors is required.");
  if (filenames.some((name) => name !== "adapter_config.json" && name !== "adapter_model.safetensors")) issues.push("Only the exact adapter filenames are accepted.");
  const totalBytes = input.files.reduce((total, file) => total + (Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0 ? file.sizeBytes : MAX_ADAPTER_BYTES), 0);
  if (totalBytes >= MAX_ADAPTER_BYTES) issues.push("Total adapter files must remain below 300 MB.");
  if (!input.provenance.trim()) issues.push("Explicit dataset provenance is required.");
  if (!input.license.trim()) issues.push("Explicit dataset and model license information is required.");
  if (!Object.values(input.approvals).every(Boolean)) issues.push("Every dataset, base-model, license, cost, and account approval gate is required.");
  return { compatible: issues.length === 0, uploadAllowed: false, issues };
}
