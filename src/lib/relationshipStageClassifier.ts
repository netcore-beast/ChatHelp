import {
  RELATIONSHIP_STAGES,
  isMessagingRole,
  isRelationshipStage,
  type MessagingRole,
  type RelationshipStage,
  type RelationshipStageFeatureRecord,
  type StageMessageCountBucket,
} from "./workspaceTypes";

export type { RelationshipStageFeatureRecord } from "./workspaceTypes";

export const STAGE_FEATURE_SCHEMA_VERSION = 1 as const;
const MAX_SEMANTIC_TOKENS = 24;
const STOP_WORDS = new Set(["about", "after", "again", "also", "and", "are", "for", "from", "have", "into", "most", "that", "the", "their", "this", "what", "when", "which", "with", "would", "your"]);

export interface RelationshipStageFeatures {
  featureSchemaVersion: 1;
  role: MessagingRole;
  messageCountBucket: StageMessageCountBucket;
  hasIncomingQuestion: boolean;
  hasNeedSignal: boolean;
  hasPermissionSignal: boolean;
  hasValueDiscussionSignal: boolean;
  hasNextStepSignal: boolean;
  semanticTokens: string[];
}

export interface RelationshipStageClassifierModel {
  modelVersion: 1;
  featureSchemaVersion: 1;
  labels: readonly RelationshipStage[];
  trainingRecordCount: number;
  labelDocumentCounts: Record<RelationshipStage, number>;
  labelTokenTotals: Record<RelationshipStage, number>;
  tokenCounts: Record<RelationshipStage, Record<string, number>>;
  vocabulary: string[];
}

export interface RelationshipStagePrediction {
  stage: RelationshipStage;
  suggestedStage: RelationshipStage;
  confidence: number;
  usedFallback: boolean;
}

function cleanTokens(values: readonly unknown[]): string[] {
  return Array.from(new Set(values.flatMap((value) => typeof value === "string"
    ? (value.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]{3,40}/gu) ?? [])
    : []).filter((token) => !STOP_WORDS.has(token)))).sort().slice(0, MAX_SEMANTIC_TOKENS);
}

function messageCountBucket(value: number): StageMessageCountBucket {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 4) return "low";
  if (value < 15) return "medium";
  return "high";
}

export function extractRelationshipStageFeatures(input: {
  role: MessagingRole;
  conversationGoal?: string;
  latestIncoming?: string;
  messageCount?: number;
}): RelationshipStageFeatures {
  const evidence = `${input.conversationGoal ?? ""} ${input.latestIncoming ?? ""}`.normalize("NFKC").toLocaleLowerCase("en-US").slice(0, 2_000);
  return {
    featureSchemaVersion: 1,
    role: input.role,
    messageCountBucket: messageCountBucket(input.messageCount ?? -1),
    hasIncomingQuestion: /\?/.test(input.latestIncoming ?? ""),
    hasNeedSignal: /\b(?:need|challenge|problem|priority|goal|support|struggle)\b/u.test(evidence),
    hasPermissionSignal: /\b(?:permission|open to|may i|would you like|okay if)\b/u.test(evidence),
    hasValueDiscussionSignal: /\b(?:product|business|solution|value|offer|service|benefit)\b/u.test(evidence),
    hasNextStepSignal: /\b(?:next step|follow up|schedule|call|meeting|send you|circle back)\b/u.test(evidence),
    semanticTokens: cleanTokens([input.conversationGoal ?? "", input.latestIncoming ?? ""]),
  };
}

export function normalizeStageTrainingRecord(value: unknown, index = 0): RelationshipStageFeatureRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.slice(0, 200) : "";
  if (!id || item.featureSchemaVersion !== 1 || !isMessagingRole(item.role) || !isRelationshipStage(item.confirmedStage)) return null;
  const bucket = item.messageCountBucket === "low" || item.messageCountBucket === "medium" || item.messageCountBucket === "high" ? item.messageCountBucket : "unknown";
  const createdAt = typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt.slice(0, 100) : `1970-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`;
  return {
    id,
    featureSchemaVersion: 1,
    role: item.role,
    messageCountBucket: bucket,
    hasIncomingQuestion: item.hasIncomingQuestion === true,
    hasNeedSignal: item.hasNeedSignal === true,
    hasPermissionSignal: item.hasPermissionSignal === true,
    hasValueDiscussionSignal: item.hasValueDiscussionSignal === true,
    hasNextStepSignal: item.hasNextStepSignal === true,
    semanticTokens: cleanTokens(Array.isArray(item.semanticTokens) ? item.semanticTokens : []),
    confirmedStage: item.confirmedStage,
    humanConfirmed: item.humanConfirmed === true,
    createdAt,
  };
}

function featureTokens(features: RelationshipStageFeatures): string[] {
  return [
    `role_${features.role.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "_")}`,
    `messages_${features.messageCountBucket}`,
    features.hasIncomingQuestion ? "incoming_question_yes" : "incoming_question_no",
    features.hasNeedSignal ? "need_yes" : "need_no",
    features.hasPermissionSignal ? "permission_yes" : "permission_no",
    features.hasValueDiscussionSignal ? "value_yes" : "value_no",
    features.hasNextStepSignal ? "next_step_yes" : "next_step_no",
    ...cleanTokens(features.semanticTokens).flatMap((token) => Array(4).fill(`semantic_${token}`) as string[]),
  ];
}

function emptyLabelRecord<T>(factory: () => T): Record<RelationshipStage, T> {
  return Object.fromEntries(RELATIONSHIP_STAGES.map((stage) => [stage, factory()])) as Record<RelationshipStage, T>;
}

export function trainStageClassifier(values: readonly unknown[]): RelationshipStageClassifierModel {
  const records = values.flatMap((value, index) => {
    const record = normalizeStageTrainingRecord(value, index);
    return record?.humanConfirmed ? [record] : [];
  }).sort((left, right) => left.id.localeCompare(right.id));
  const labelDocumentCounts = emptyLabelRecord(() => 0);
  const labelTokenTotals = emptyLabelRecord(() => 0);
  const tokenCounts = emptyLabelRecord<Record<string, number>>(() => ({}));
  const vocabulary = new Set<string>();

  for (const record of records) {
    labelDocumentCounts[record.confirmedStage] += 1;
    const tokens = featureTokens(record);
    for (const token of tokens) {
      vocabulary.add(token);
      tokenCounts[record.confirmedStage][token] = (tokenCounts[record.confirmedStage][token] ?? 0) + 1;
      labelTokenTotals[record.confirmedStage] += 1;
    }
  }
  for (const stage of RELATIONSHIP_STAGES) {
    tokenCounts[stage] = Object.fromEntries(Object.entries(tokenCounts[stage]).sort(([left], [right]) => left.localeCompare(right)));
  }
  return {
    modelVersion: 1,
    featureSchemaVersion: 1,
    labels: RELATIONSHIP_STAGES,
    trainingRecordCount: records.length,
    labelDocumentCounts,
    labelTokenTotals,
    tokenCounts,
    vocabulary: [...vocabulary].sort(),
  };
}

export function predictRelationshipStage(
  model: RelationshipStageClassifierModel,
  features: RelationshipStageFeatures,
  fallbackStage: RelationshipStage,
  confidenceThreshold = 0.70,
): RelationshipStagePrediction {
  if (!model.trainingRecordCount || features.featureSchemaVersion !== model.featureSchemaVersion) {
    return { stage: fallbackStage, suggestedStage: fallbackStage, confidence: 0, usedFallback: true };
  }
  const vocabularySize = Math.max(1, model.vocabulary.length);
  const tokens = featureTokens(features);
  const trainedLabels = RELATIONSHIP_STAGES.filter((stage) => model.labelDocumentCounts[stage] > 0);
  const scores = trainedLabels.map((stage) => {
    let score = Math.log((model.labelDocumentCounts[stage] + 1) / (model.trainingRecordCount + RELATIONSHIP_STAGES.length));
    const denominator = model.labelTokenTotals[stage] + vocabularySize;
    for (const token of tokens) score += Math.log(((model.tokenCounts[stage][token] ?? 0) + 1) / denominator);
    return { stage, score };
  }).sort((left, right) => right.score - left.score || RELATIONSHIP_STAGES.indexOf(left.stage) - RELATIONSHIP_STAGES.indexOf(right.stage));
  const maxScore = scores[0].score;
  const weights = scores.map(({ score }) => Math.exp(score - maxScore));
  const confidence = weights[0] / weights.reduce((total, weight) => total + weight, 0);
  const suggestedStage = scores[0].stage;
  const usedFallback = confidence < Math.min(1, Math.max(0, confidenceThreshold));
  return {
    stage: usedFallback ? fallbackStage : suggestedStage,
    suggestedStage,
    confidence: Number(confidence.toFixed(4)),
    usedFallback,
  };
}

export function evaluateStageClassifier(values: readonly unknown[]): {
  evaluatedRecords: number;
  accuracy: number;
  byStage: Record<RelationshipStage, { evaluated: number; correct: number }>;
} {
  const records = values.flatMap((value, index) => {
    const record = normalizeStageTrainingRecord(value, index);
    return record?.humanConfirmed ? [record] : [];
  }).sort((left, right) => left.id.localeCompare(right.id));
  const byStage = emptyLabelRecord(() => ({ evaluated: 0, correct: 0 }));
  let correct = 0;
  for (const heldOut of records) {
    const model = trainStageClassifier(records.filter((record) => record.id !== heldOut.id));
    const prediction = predictRelationshipStage(model, heldOut, heldOut.confirmedStage, 0);
    byStage[heldOut.confirmedStage].evaluated += 1;
    if (prediction.suggestedStage === heldOut.confirmedStage) {
      correct += 1;
      byStage[heldOut.confirmedStage].correct += 1;
    }
  }
  return { evaluatedRecords: records.length, accuracy: records.length ? correct / records.length : 0, byStage };
}
