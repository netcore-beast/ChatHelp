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
  "storedStage",
  "observedStage",
  "effectiveStage",
  "nextAllowedStage",
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
    storedStage: { type: "string", enum: RELATIONSHIP_STAGES },
    observedStage: { type: "string", enum: RELATIONSHIP_STAGES },
    effectiveStage: { type: "string", enum: RELATIONSHIP_STAGES },
    nextAllowedStage: { type: "string", enum: RELATIONSHIP_STAGES },
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
    total: { type: "integer", minimum: 0, maximum: 100 },
    criticalFailures: { type: "array", maxItems: 8, items: { type: "string" } },
    rewritten: { type: "boolean" },
    finalDraft: { type: "string" },
  },
  required: ["scores", "total", "criticalFailures", "rewritten", "finalDraft"],
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

export function canIntroduceValue(stage, context) {
  if (context?.explicitRequest === true) return true;
  return RELATIONSHIP_STAGES.indexOf(stage) >= RELATIONSHIP_STAGES.indexOf("introduce_value")
    && context?.needEstablished === true
    && context?.permissionGranted === true;
}

export function parseDraftAnalysis(value) {
  if (!hasExactKeys(value, ANALYSIS_KEYS)) throw new Error("Invalid analysis fields");
  if (!isStage(value.storedStage) || !isStage(value.observedStage) || !isStage(value.effectiveStage) || !isStage(value.nextAllowedStage)) {
    throw new Error("Invalid relationship stage");
  }
  const parsed = {
    storedStage: value.storedStage,
    observedStage: value.observedStage,
    effectiveStage: value.effectiveStage,
    nextAllowedStage: value.nextAllowedStage,
    latestIncomingIntent: boundedText(value.latestIncomingIntent, 1_000),
    knownFacts: boundedList(value.knownFacts, 12, 500),
    unansweredQuestions: boundedList(value.unansweredQuestions, 12, 500),
    goalForThisReply: boundedText(value.goalForThisReply, 1_000),
    toneDirectives: boundedList(value.toneDirectives, 12, 300),
    prohibitedMoves: boundedList(value.prohibitedMoves, 16, 500),
    replyPlan: boundedText(value.replyPlan, 2_000),
    evidence: boundedList(value.evidence, 12, 200),
    needEstablished: value.needEstablished,
    permissionGranted: value.permissionGranted,
    explicitRequest: value.explicitRequest,
  };
  if ([parsed.needEstablished, parsed.permissionGranted, parsed.explicitRequest].some((item) => typeof item !== "boolean")) {
    throw new Error("Invalid analysis flags");
  }
  if (parsed.nextAllowedStage !== nextStage(parsed.storedStage)
      || parsed.effectiveStage !== effectiveStage(parsed.storedStage, parsed.observedStage, parsed.evidence)) {
    throw new Error("Invalid stage progression");
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
  if (!hasExactKeys(value, ["scores", "total", "criticalFailures", "rewritten", "finalDraft"])) throw new Error("Invalid review object");
  if (!hasExactKeys(value.scores, Object.keys(RUBRIC_WEIGHTS))) throw new Error("Invalid review scores");
  const scores = {};
  for (const [dimension, maximum] of Object.entries(RUBRIC_WEIGHTS)) {
    const score = value.scores[dimension];
    if (!Number.isInteger(score) || score < 0 || score > maximum) throw new Error("Invalid review scores");
    scores[dimension] = score;
  }
  if (!Number.isInteger(value.total) || value.total < 0 || value.total > 100) throw new Error("Invalid review total");
  if (!Array.isArray(value.criticalFailures) || value.criticalFailures.length > 8 || value.criticalFailures.some((item) => typeof item !== "string")) {
    throw new Error("Invalid critical failures");
  }
  if (typeof value.rewritten !== "boolean") throw new Error("Invalid review rewrite flag");
  return {
    scores,
    total: value.total,
    criticalFailures: value.criticalFailures.map((item) => item.trim().slice(0, 200)).filter(Boolean),
    rewritten: value.rewritten,
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

const VALUE_INTRODUCTION_PATTERN = /\b(?:business opportunity|product|income opportunity|join (?:my|our)|compensation plan|purchase|buy|customer offer)\b/i;

export function validateFinalReview(value, context = {}) {
  let review;
  try {
    review = parseFinalReview(value);
  } catch {
    return { ok: false, reason: "schema" };
  }
  if (review.criticalFailures.length) return { ok: false, reason: "critical" };
  const calculatedTotal = Object.values(review.scores).reduce((total, score) => total + score, 0);
  if (calculatedTotal !== review.total) return { ok: false, reason: "total" };
  if (review.total < 90) return { ok: false, reason: "rubric" };

  const normalizedDraft = normalizedComparableText(review.finalDraft);
  const normalizedContext = normalizedComparableText(context.conversationText ?? "");
  if (normalizedDraft.length >= 30 && normalizedContext.includes(normalizedDraft)) return { ok: false, reason: "copied" };
  if (UNSUPPORTED_PERSONAL_HISTORY_PATTERNS.some((pattern) => pattern.test(review.finalDraft))) return { ok: false, reason: "unsupported_history" };
  if (context.canIntroduceValue !== true && VALUE_INTRODUCTION_PATTERN.test(review.finalDraft)) return { ok: false, reason: "premature_pitch" };
  if ((review.finalDraft.match(/\?/g) ?? []).length > 1) return { ok: false, reason: "question_heavy" };
  return { ok: true, draft: review.finalDraft };
}
