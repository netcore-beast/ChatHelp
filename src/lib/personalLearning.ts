import {
  CONVERSATION_GOAL_MAX_CHARS,
  isMessagingRole,
  normalizeMessagingRole,
  normalizeRelationshipStage,
  type Feedback,
  type MessagingRole,
  type RelationshipStage,
} from "./workspaceTypes";

const MAX_FEEDBACK_TEXT_CHARS = 5_000;
const MAX_REASON_CHARS = 1_000;
const MAX_OUTCOME_CHARS = 1_000;
const MAX_MODEL_ID_CHARS = 300;
const MAX_SELECTED_EXAMPLES = 3;
const TOKEN_LIMIT = 80;

export interface LearningQuery {
  currentContactId: string;
  role: MessagingRole;
  relationshipStage: RelationshipStage;
  conversationGoal: string;
  outcome?: string;
}

export interface SelectedLearningExample {
  role: string;
  relationshipStage: RelationshipStage;
  conversationGoal: string;
  preferredResponse: string;
}

function boundedString(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return Array.from(value.normalize("NFC").trim()).slice(0, limit).join("");
}

function normalizedTimestamp(value: unknown, fallback: string): string {
  const candidate = boundedString(value, 100);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : fallback;
}

export function normalizeFeedback(value: unknown, index = 0): Feedback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = boundedString(item.id, 200);
  const contactId = boundedString(item.contactId, 200);
  const draft = boundedString(item.draft, MAX_FEEDBACK_TEXT_CHARS);
  const preferredResponse = boundedString(item.preferredResponse, MAX_FEEDBACK_TEXT_CHARS);
  const legacyRating = item.rating === "useful" || item.rating === "not-useful" ? item.rating : undefined;
  const action = item.action === "accepted" || item.action === "edited" || item.action === "rejected"
    ? item.action
    : legacyRating === "useful" ? "accepted" : legacyRating === "not-useful" ? "rejected" : null;
  if (!id || !contactId || !action || (!draft && !preferredResponse)) return null;

  const createdAt = normalizedTimestamp(item.createdAt, "1970-01-01T00:00:00.000Z");
  const updatedAt = normalizedTimestamp(item.updatedAt, createdAt);
  const role = isMessagingRole(item.role) ? item.role : normalizeMessagingRole("");
  const provider = item.provider === "anthropic" || item.provider === "cloudflare" || item.provider === "local" || item.provider === "unknown"
    ? item.provider
    : "unknown";
  const origin = item.origin === "independently_user_authored" ? "independently_user_authored" : "provider_assisted";
  const independentlyAuthoredAttested = origin === "independently_user_authored" && item.independentlyAuthoredAttested === true;
  const enabled = item.enabled !== false;
  const normalizedPreferredResponse = preferredResponse || (legacyRating === "useful" ? draft : "");
  const eligibleForRetrieval = enabled
    && action !== "rejected"
    && origin === "independently_user_authored"
    && independentlyAuthoredAttested
    && Boolean(normalizedPreferredResponse)
    && item.eligibleForRetrieval === true;

  return {
    id: id || `feedback-${index}`,
    contactId,
    role,
    relationshipStage: normalizeRelationshipStage(item.relationshipStage),
    conversationGoal: boundedString(item.conversationGoal, CONVERSATION_GOAL_MAX_CHARS),
    provider,
    modelId: boundedString(item.modelId, MAX_MODEL_ID_CHARS),
    action,
    draft,
    preferredResponse: normalizedPreferredResponse,
    outcome: boundedString(item.outcome, MAX_OUTCOME_CHARS),
    reason: boundedString(item.reason ?? item.note, MAX_REASON_CHARS),
    origin,
    independentlyAuthoredAttested,
    eligibleForRetrieval,
    enabled,
    createdAt,
    updatedAt,
    ...(legacyRating ? { rating: legacyRating } : {}),
    ...(typeof item.note === "string" ? { note: boundedString(item.note, MAX_REASON_CHARS) } : {}),
  };
}

export function isGenerativeTrainingEligible(value: unknown): boolean {
  const record = normalizeFeedback(value);
  return Boolean(record
    && record.enabled
    && record.action !== "rejected"
    && record.origin === "independently_user_authored"
    && record.independentlyAuthoredAttested
    && record.eligibleForRetrieval
    && record.preferredResponse);
}

function tokens(value: string): Set<string> {
  const matches = value.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return new Set(matches.slice(0, TOKEN_LIMIT));
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

export function selectLearningExamples(
  values: readonly unknown[],
  query: LearningQuery,
  limit = MAX_SELECTED_EXAMPLES,
): SelectedLearningExample[] {
  if (!Array.isArray(values) || !isMessagingRole(query.role)) return [];
  const queryGoalTokens = tokens(boundedString(query.conversationGoal, CONVERSATION_GOAL_MAX_CHARS));
  const queryOutcomeTokens = tokens(boundedString(query.outcome, MAX_OUTCOME_CHARS));
  const boundedLimit = Math.min(MAX_SELECTED_EXAMPLES, Math.max(0, Math.floor(Number.isFinite(limit) ? limit : MAX_SELECTED_EXAMPLES)));
  if (!boundedLimit) return [];

  return values
    .flatMap((value, index) => {
      const record = normalizeFeedback(value, index);
      if (!record || !record.enabled || !record.eligibleForRetrieval || record.action === "rejected" || !record.preferredResponse) return [];
      const score = (record.role === query.role ? 8 : 0)
        + (record.relationshipStage === query.relationshipStage ? 10 : 0)
        + Math.min(5, overlap(tokens(record.conversationGoal), queryGoalTokens))
        + Math.min(2, overlap(tokens(record.outcome), queryOutcomeTokens));
      return [{ record, score }];
    })
    .sort((left, right) => right.score - left.score
      || right.record.updatedAt.localeCompare(left.record.updatedAt)
      || left.record.id.localeCompare(right.record.id))
    .slice(0, boundedLimit)
    .map(({ record }) => ({
      role: record.role,
      relationshipStage: record.relationshipStage,
      conversationGoal: record.conversationGoal,
      preferredResponse: record.preferredResponse,
    }));
}
