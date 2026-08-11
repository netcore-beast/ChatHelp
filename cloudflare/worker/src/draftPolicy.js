export const RELATIONSHIP_STAGES = [
  "new_connection",
  "genuine_rapport",
  "learn_interests",
  "identify_need",
  "ask_permission",
  "introduce_value",
  "answer_without_pressure",
  "voluntary_next_step",
];

export const RUBRIC_WEIGHTS = {
  conversationGrounding: 25,
  latestMessageRelevance: 20,
  personalGuidelineCompliance: 15,
  goalStageAlignment: 15,
  humanTone: 10,
  curiosityNeedDiscovery: 5,
  technicalFactualAccuracy: 5,
  ethicalSellingBoundaries: 5,
};

const ANALYSIS_KEYS = [
  "observedStage",
  "latestIncomingIntent",
  "knownFacts",
  "unansweredQuestions",
  "goalForThisReply",
  "toneDirectives",
  "prohibitedMoves",
  "replyPlan",
  "evidence",
  "needEstablished",
  "permissionGranted",
  "explicitRequest",
];

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    observedStage: { type: "string", enum: RELATIONSHIP_STAGES },
    latestIncomingIntent: { type: "string" },
    knownFacts: { type: "array", maxItems: 12, items: { type: "string" } },
    unansweredQuestions: { type: "array", maxItems: 12, items: { type: "string" } },
    goalForThisReply: { type: "string" },
    toneDirectives: { type: "array", maxItems: 12, items: { type: "string" } },
    prohibitedMoves: { type: "array", maxItems: 16, items: { type: "string" } },
    replyPlan: { type: "string" },
    evidence: { type: "array", maxItems: 12, items: { type: "string" } },
    needEstablished: { type: "boolean" },
    permissionGranted: { type: "boolean" },
    explicitRequest: { type: "boolean" },
  },
  required: ANALYSIS_KEYS,
  additionalProperties: false,
};

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    draft: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  required: ["draft"],
  additionalProperties: false,
};

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: Object.fromEntries(Object.entries(RUBRIC_WEIGHTS).map(([key, maximum]) => [key, { type: "integer", minimum: 0, maximum }])),
      required: Object.keys(RUBRIC_WEIGHTS),
      additionalProperties: false,
    },
    criticalFailures: { type: "array", maxItems: 8, items: { type: "string" } },
    finalDraft: { type: "string" },
  },
  required: ["scores", "criticalFailures", "finalDraft"],
  additionalProperties: false,
};

function isStage(value) {
  return typeof value === "string" && RELATIONSHIP_STAGES.includes(value);
}

function nextStage(stage) {
  const index = RELATIONSHIP_STAGES.indexOf(stage);
  return RELATIONSHIP_STAGES[Math.min(index + 1, RELATIONSHIP_STAGES.length - 1)];
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function boundedText(value, maximum, required = true) {
  if (typeof value !== "string") throw new Error("Invalid analysis text");
  const text = value.trim().slice(0, maximum);
  if (required && !text) throw new Error("Invalid analysis text");
  return text;
}

function boundedList(value, maximumItems, maximumCharacters) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error("Invalid analysis list");
  const list = value.map((item) => boundedText(item, maximumCharacters));
  if (list.length !== value.length) throw new Error("Invalid analysis list");
  return list;
}

export function effectiveStage(storedStage, observedStage, evidence = []) {
  if (!isStage(storedStage)) return "new_connection";
  if (!isStage(observedStage)) return storedStage;
  const storedIndex = RELATIONSHIP_STAGES.indexOf(storedStage);
  const observedIndex = RELATIONSHIP_STAGES.indexOf(observedStage);
  if (observedIndex <= storedIndex) return observedStage;
  if (!Array.isArray(evidence) || evidence.length === 0) return storedStage;
  return RELATIONSHIP_STAGES[Math.min(observedIndex, storedIndex + 1)];
}

const INTRODUCTION_REQUEST_SUBJECT = "(?:business\\s+(?:idea|opportunity)|(?:your|this|that)\\s+business(?:\\s+(?:idea|opportunity))?|side[-\\s]?income\\s+(?:program|opportunity)|income\\s+opportunity|(?:your|this|that)\\s+(?:product|service|program|platform|solution|offer))";
const INTRODUCTION_REQUEST_PATTERNS = [
  new RegExp(`\\b(?:tell|share|explain|show|send|describe|outline)\\b.{0,100}\\b${INTRODUCTION_REQUEST_SUBJECT}\\b`, "i"),
  new RegExp(`\\b(?:want|would\\s+like|like)\\s+to\\s+(?:know|hear|learn)\\b.{0,100}\\b${INTRODUCTION_REQUEST_SUBJECT}\\b`, "i"),
  new RegExp(`\\b${INTRODUCTION_REQUEST_SUBJECT}\\b.{0,80}\\b(?:details|information|info|works?|involves?|costs?|price)\\b`, "i"),
];
const INTRODUCTION_REQUEST_REJECTION = /\b(?:(?:do\s+not|don't)\s+(?:want|need|contact|message|send|share|explain|discuss)|not\s+interested|no\s+thanks|never\s+contact|stop)\b/i;

function hasVerifiedIntroductionRequest(message) {
  if (message?.sender !== "CONTACT" || typeof message.text !== "string") return false;
  const text = message.text.trim().slice(0, 5_000);
  if (!text || INTRODUCTION_REQUEST_REJECTION.test(text)) return false;
  return INTRODUCTION_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

export function canIntroduceValue(stage, context, latestActualMessage) {
  if (context?.explicitRequest === true && hasVerifiedIntroductionRequest(latestActualMessage)) return true;
  return RELATIONSHIP_STAGES.indexOf(stage) >= RELATIONSHIP_STAGES.indexOf("introduce_value")
    && context?.needEstablished === true
    && context?.permissionGranted === true;
}

export function parseDraftAnalysis(value, storedStage) {
  if (!hasExactKeys(value, ANALYSIS_KEYS)) throw new Error("Invalid analysis fields");
  if (!isStage(storedStage) || !isStage(value.observedStage)) {
    throw new Error("Invalid relationship stage");
  }
  const evidence = boundedList(value.evidence, 12, 200);
  const parsed = {
    storedStage,
    observedStage: value.observedStage,
    effectiveStage: effectiveStage(storedStage, value.observedStage, evidence),
    nextAllowedStage: nextStage(storedStage),
    latestIncomingIntent: boundedText(value.latestIncomingIntent, 1_000),
    knownFacts: boundedList(value.knownFacts, 12, 500),
    unansweredQuestions: boundedList(value.unansweredQuestions, 12, 500),
    goalForThisReply: boundedText(value.goalForThisReply, 1_000),
    toneDirectives: boundedList(value.toneDirectives, 12, 300),
    prohibitedMoves: boundedList(value.prohibitedMoves, 16, 500),
    replyPlan: boundedText(value.replyPlan, 2_000),
    evidence,
    needEstablished: value.needEstablished,
    permissionGranted: value.permissionGranted,
    explicitRequest: value.explicitRequest,
  };
  if ([parsed.needEstablished, parsed.permissionGranted, parsed.explicitRequest].some((item) => typeof item !== "boolean")) {
    throw new Error("Invalid analysis flags");
  }
  return parsed;
}

export function parseDraftCandidate(value) {
  if (!hasExactKeys(value, ["draft"]) || !hasExactKeys(value.draft, ["text"])) throw new Error("Invalid draft object");
  return {
    text: boundedText(value.draft.text, 5_000),
  };
}

export function parseFinalReview(value) {
  if (!hasExactKeys(value, ["scores", "criticalFailures", "finalDraft"])) throw new Error("Invalid review object");
  if (!hasExactKeys(value.scores, Object.keys(RUBRIC_WEIGHTS))) throw new Error("Invalid review scores");
  const scores = {};
  for (const [dimension, maximum] of Object.entries(RUBRIC_WEIGHTS)) {
    const score = value.scores[dimension];
    if (!Number.isInteger(score) || score < 0 || score > maximum) throw new Error("Invalid review scores");
    scores[dimension] = score;
  }
  if (!Array.isArray(value.criticalFailures) || value.criticalFailures.length > 8 || value.criticalFailures.some((item) => typeof item !== "string")) {
    throw new Error("Invalid critical failures");
  }
  return {
    scores,
    criticalFailures: value.criticalFailures.map((item) => item.trim().slice(0, 200)).filter(Boolean),
    finalDraft: boundedText(value.finalDraft, 5_000),
  };
}

function normalizedComparableText(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const UNSUPPORTED_PERSONAL_HISTORY_PATTERNS = [
  /\b(?:honestly,?\s*)?i\s+(?:first\s+)?got into\b/i,
  /\bmy\s+(?:motivation|inspiration|interest)\s+(?:came|comes|started|began|grew|was sparked)\b/i,
  /\bi\s+(?:became|got)\s+(?:interested|involved)\s+in\b/i,
  /\bwhat\s+(?:drew|inspired|motivated)\s+me\b/i,
  /\bi\s+(?:started|chose|decided)\b[^.!?]{0,100}\b(?:because|after|when)\b/i,
];

const VALUE_INTRODUCTION_PATTERNS = [
  /\b(?:my|our|this)\s+(?:business\s+(?:idea|opportunity)|side[-\s]?income\s+(?:program|opportunity)|income\s+opportunity|compensation\s+plan|customer\s+offer)\b/i,
  /\b(?:i|we)\s+(?:have|offer|run|created|built|want\s+to\s+share|would\s+like\s+to\s+share)\s+(?:a|an|the)?\s*(?:business\s+(?:idea|opportunity)|side[-\s]?income\s+(?:program|opportunity)|income\s+opportunity)\b/i,
  /\bjoin\s+(?:my|our)\b/i,
  /\b(?:purchase|buy|subscribe\s+to|sign\s+up\s+for)\s+(?:my|our|this|the)\s+(?:[a-z0-9&'-]+\s+){0,5}(?:service|product|program|platform|solution|offer)\b/i,
  /\b(?:my|our)\s+(?:[a-z0-9&'-]+\s+){0,5}(?:service|product|program|platform|solution|offer)\b/i,
  /\b(?:i|we)\s+(?:can|could|would|would\s+like\s+to|'d\s+like\s+to)?\s*(?:show|share|introduce|offer|recommend)\b[^.!?]{0,100}\b(?:my|our|a|an|this)\s+(?:[a-z0-9&'-]+\s+){0,5}(?:service|product|program|platform|solution|offer)\b/i,
  /\b(?:I|We)\s+(?:(?:can|could|would)\s+)?(?:show|share|introduce|recommend)\s+(?:you\s+)?(?:the\s+)?[A-Z][A-Za-z0-9&'-]*(?:\s+[A-Z][A-Za-z0-9&'-]*){1,4}\b/,
  /\b(?:i|we)\s+(?:(?:can|could)\s+)?(?:help|show|teach|guide|support|work\s+with)\b[^.!?]{0,120}\b(?:create|build|generate|develop|earn|make)\b[^.!?]{0,80}\b(?:(?:extra|additional|another|side|supplemental|passive)\s+income|(?:income|revenue)\s+stream)\b/i,
  /\b(?:earn|make|generate)\s+(?:an?\s+)?(?:extra|additional|side|supplemental|passive)\s+income\b/i,
];

export function validateFinalReview(value, context = {}) {
  let review;
  try {
    review = parseFinalReview(value);
  } catch {
    return { ok: false, reason: "schema" };
  }
  if (review.criticalFailures.length) return { ok: false, reason: "critical" };
  const calculatedTotal = Object.values(review.scores).reduce((total, score) => total + score, 0);
  if (calculatedTotal < 90) return { ok: false, reason: "rubric" };

  const normalizedDraft = normalizedComparableText(review.finalDraft);
  const normalizedContext = normalizedComparableText(context.conversationText ?? "");
  if (normalizedDraft.length >= 30 && normalizedContext.includes(normalizedDraft)) return { ok: false, reason: "copied" };
  if (UNSUPPORTED_PERSONAL_HISTORY_PATTERNS.some((pattern) => pattern.test(review.finalDraft))) return { ok: false, reason: "unsupported_history" };
  if (context.canIntroduceValue !== true && VALUE_INTRODUCTION_PATTERNS.some((pattern) => pattern.test(review.finalDraft))) {
    return { ok: false, reason: "premature_pitch" };
  }
  if ((review.finalDraft.match(/\?/g) ?? []).length > 1) return { ok: false, reason: "question_heavy" };
  return { ok: true, draft: review.finalDraft };
}
