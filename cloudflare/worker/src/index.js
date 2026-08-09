import { authenticateAccessRequest } from "./accessAuth.js";
import { cleanupExpiredLearningRecords, handleLearningRequest, retrieveLearningExamples } from "./neonLearning.js";
import { cleanupExpiredVaults, handleVaultRequest } from "./neonVault.js";
import {
  ANTHROPIC_MODEL,
  SINGLE_DRAFT_MODE,
  AnthropicPipelineError,
  runAnthropicDraftPipeline,
} from "./anthropicDraftPipeline.js";
import { RELATIONSHIP_STAGES } from "./draftPolicy.js";
import { goalCategoryForStage, roleIdForMessagingRole } from "./learningPolicy.js";
import { resolveNeonContext } from "./neonDb.js";
import {
  GPT_REVIEW_MODEL,
  LLAMA_CANDIDATE_MODEL,
  WORKERS_AI_MODEL,
  WorkersAiPipelineError,
  runWorkersAiDraftPipeline,
} from "./workersAiDraftPipeline.js";

export { ANTHROPIC_MODEL, GPT_REVIEW_MODEL, LLAMA_CANDIDATE_MODEL, WORKERS_AI_MODEL };
export const PIPELINE_MODE = SINGLE_DRAFT_MODE;
export const MAX_PROMPT_CHARS = 180_000;
export const MAX_REQUEST_BYTES = 512_000;
const MAX_ROLE_CHARS = 400;
const MAX_RELATIONSHIP_GOAL_CHARS = 20_000;
const MAX_VOICE_CHARS = 4_000;
const MAX_REPLY_RULES_CHARS = 50_000;
const MAX_RULEBOOK_DIGEST_CHARS = 8_000;
const MAX_REPLY_OBJECTIVE_CHARS = 5_000;
const MAX_PERSONAL_GUIDELINES_CHARS = 2_000;
const MAX_CONVERSATION_GOAL_CHARS = 5_000;
const SAFE_GENERATION_ERROR = "Cloud AI could not produce a safe draft. Please try again.";
const DRAFT_PAYLOAD_KEYS = new Set([
  "conversationContext",
  "latestActualMessage",
  "latestMeaningfulIncoming",
  "playbook",
  "personalGuidelines",
  "conversationGoal",
  "relationshipStage",
  "knownFacts",
  "unansweredQuestions",
  "replyObjective",
]);

class DraftPipelineFailure extends Error {
  constructor(primaryError, fallbackError) {
    super(SAFE_GENERATION_ERROR);
    this.name = "DraftPipelineFailure";
    this.diagnosticCode = `anthropic_${primaryError.kind}_${primaryError.code ?? primaryError.kind}__cloudflare_${fallbackError.kind}_${fallbackError.code ?? fallbackError.kind}`;
  }
}

function safeDiagnosticCode(error) {
  return error instanceof DraftPipelineFailure ? error.diagnosticCode : "pipeline_unclassified";
}

function safeGenerationErrorPayload(error) {
  const diagnosticCode = safeDiagnosticCode(error);
  return {
    error: `${SAFE_GENERATION_ERROR} Diagnostic: ${diagnosticCode}`,
    diagnosticCode,
  };
}

function reportPipelineFailure(options, primaryError, fallbackError) {
  const entry = {
    event: "draft_pipeline_failed",
    primary: { provider: "anthropic", kind: primaryError.kind, code: primaryError.code ?? primaryError.kind },
    fallback: { provider: "cloudflare", kind: fallbackError.kind, code: fallbackError.code ?? fallbackError.kind },
  };
  if (typeof options.logError === "function") options.logError(entry);
  else console.error(JSON.stringify(entry));
}

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...RESPONSE_HEADERS, ...extraHeaders },
  });
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function limitedText(value, maxCharacters) {
  return typeof value === "string" ? value.trim().slice(0, maxCharacters) : "";
}

function escapedBlockText(value) {
  return String(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function normalizeConversationBlock(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const open = "<conversation_context>";
  const close = "</conversation_context>";
  const inner = raw.startsWith(open) && raw.endsWith(close)
    ? raw.slice(open.length, -close.length).trim()
    : raw;
  return `${open}\n${escapedBlockText(inner)}\n${close}`;
}

function parseBoundedList(value, maximumItems, maximumCharacters) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error("invalid");
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("invalid");
    return limitedText(item, maximumCharacters);
  }).filter(Boolean);
}

function parseConversationMessage(value, requiredSender) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || !["USER", "CONTACT"].includes(value.sender)) throw new Error("invalid");
  if (requiredSender && value.sender !== requiredSender) throw new Error("invalid");
  const parsed = {
    id: limitedText(value.id, 200),
    sender: value.sender,
    speaker: limitedText(value.speaker, 200),
    text: limitedText(value.text, 900),
    timestamp: limitedText(value.timestamp, 100),
  };
  if (!parsed.id || !parsed.text) throw new Error("invalid");
  return parsed;
}

function parseDraftPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid");
  if (Object.keys(payload).some((key) => !DRAFT_PAYLOAD_KEYS.has(key))) throw new Error("invalid");
  const conversationContext = normalizeConversationBlock(payload.conversationContext);
  if (!conversationContext) throw new Error("invalid");
  if (conversationContext.length > MAX_PROMPT_CHARS) throw new Error("oversized");
  if (!RELATIONSHIP_STAGES.includes(payload.relationshipStage)) throw new Error("invalid");

  const rawGuidelines = typeof payload.personalGuidelines === "string" ? payload.personalGuidelines.normalize("NFC").trim() : "";
  if (Array.from(rawGuidelines).length > MAX_PERSONAL_GUIDELINES_CHARS) throw new Error("oversized");
  const rawPlaybook = payload.playbook && typeof payload.playbook === "object" && !Array.isArray(payload.playbook) ? payload.playbook : {};
  const playbook = {
    role: limitedText(rawPlaybook.role, MAX_ROLE_CHARS),
    relationshipGoal: limitedText(rawPlaybook.relationshipGoal, MAX_RELATIONSHIP_GOAL_CHARS),
    voice: limitedText(rawPlaybook.voice, MAX_VOICE_CHARS),
    rulebookFull: limitedText(rawPlaybook.rulebookFull, MAX_REPLY_RULES_CHARS),
    rulebookDigest: limitedText(rawPlaybook.rulebookDigest, MAX_RULEBOOK_DIGEST_CHARS),
  };
  if (!playbook.rulebookDigest) playbook.rulebookDigest = playbook.rulebookFull.slice(0, MAX_RULEBOOK_DIGEST_CHARS);

  return {
    conversationContext,
    latestActualMessage: parseConversationMessage(payload.latestActualMessage ?? payload.latestMeaningfulIncoming ?? null),
    latestMeaningfulIncoming: parseConversationMessage(payload.latestMeaningfulIncoming ?? null, "CONTACT"),
    playbook,
    personalGuidelines: rawGuidelines,
    conversationGoal: limitedText(payload.conversationGoal, MAX_CONVERSATION_GOAL_CHARS),
    relationshipStage: payload.relationshipStage,
    knownFacts: parseBoundedList(payload.knownFacts, 12, 500),
    unansweredQuestions: parseBoundedList(payload.unansweredQuestions, 12, 500),
    replyObjective: limitedText(payload.replyObjective, MAX_REPLY_OBJECTIVE_CHARS),
  };
}

async function addRetrievedLearningExamples(context, env, url, identity, options) {
  const withoutExamples = { ...context, retrievedLearningExamples: [] };
  try {
    const neonContext = resolveNeonContext(env, url.hostname);
    if (neonContext.environment !== identity.environment) return withoutExamples;
    const roleId = roleIdForMessagingRole(context.playbook.role);
    const goalCategory = goalCategoryForStage(context.relationshipStage);
    if (!roleId || !goalCategory) return withoutExamples;
    const examples = await retrieveLearningExamples(neonContext.binding, identity.accountId, {
      roleId,
      relationshipStage: context.relationshipStage,
      goalCategory,
    }, options);
    return { ...context, retrievedLearningExamples: examples.slice(0, 3) };
  } catch {
    return withoutExamples;
  }
}

function createOrderedStageEmitter(emit) {
  const stages = ["analyzing", "drafting", "reviewing", "finalizing"];
  const seen = new Set();
  let furthest = -1;
  return (event, data) => {
    if (event !== "stage") return;
    const index = stages.indexOf(data?.stage);
    if (index < 0 || (data?.status !== "in-progress" && data?.status !== "done")) return;
    if (index < furthest) return;
    const key = `${data.stage}:${data.status}`;
    if (seen.has(key)) return;
    if (data.status === "done" && !seen.has(`${data.stage}:in-progress`)) return;
    furthest = Math.max(furthest, index);
    seen.add(key);
    emit(event, data);
  };
}

async function runWorkersAiWithQualityRetry(context, env, emit) {
  try {
    return await runWorkersAiDraftPipeline(context, { ai: env.AI, emit });
  } catch (error) {
    if (!(error instanceof WorkersAiPipelineError) || error.kind !== "quality") throw error;
    return runWorkersAiDraftPipeline(context, { ai: env.AI, emit });
  }
}

async function runProviderPipeline(context, env, options, emit) {
  const orderedEmit = createOrderedStageEmitter(emit);
  if (options.providerOverride === "cloudflare") {
    const result = await runWorkersAiWithQualityRetry(context, env, orderedEmit);
    orderedEmit("stage", { stage: "finalizing", status: "in-progress" });
    orderedEmit("stage", { stage: "finalizing", status: "done" });
    return result;
  }
  try {
    const result = await runAnthropicDraftPipeline(context, {
      apiKey: env.ANTHROPIC_API_KEY,
      request: options.anthropicFetch,
      signal: options.signal,
      timeoutMs: options.anthropicTimeoutMs,
      emit: orderedEmit,
    });
    orderedEmit("stage", { stage: "finalizing", status: "in-progress" });
    orderedEmit("stage", { stage: "finalizing", status: "done" });
    return result;
  } catch (error) {
    if (!(error instanceof AnthropicPipelineError) || error.kind === "cancelled") throw error;
    let result;
    try {
      result = await runWorkersAiWithQualityRetry(context, env, orderedEmit);
    } catch (fallbackError) {
      if (fallbackError instanceof WorkersAiPipelineError) {
        reportPipelineFailure(options, error, fallbackError);
        throw new DraftPipelineFailure(error, fallbackError);
      }
      throw fallbackError;
    }
    orderedEmit("stage", { stage: "finalizing", status: "in-progress" });
    orderedEmit("stage", { stage: "finalizing", status: "done" });
    return result;
  }
}

export async function handleRequest(request, env, options = {}) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "dialogmint-cloud",
      provider: "anthropic-primary-cloudflare-fallback",
      model: ANTHROPIC_MODEL,
      models: [ANTHROPIC_MODEL, LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      fallbackModel: WORKERS_AI_MODEL,
      fallbackModels: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      mode: PIPELINE_MODE,
      anthropicConfigured: typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0,
      authentication: "cloudflare-access-jwt",
      accessBindings: {
        teamDomain: Boolean(String(env.ACCESS_TEAM_DOMAIN ?? "").trim()),
        testingAudience: Boolean(String(env.ACCESS_AUD_TESTING ?? "").trim()),
        productionAudience: Boolean(String(env.ACCESS_AUD_PRODUCTION ?? "").trim()),
      },
      persistentStorage: "client-encrypted-neon",
      retentionDays: 90,
      vaultBindings: {
        testing: Boolean(env.NEON_TESTING?.connectionString),
        production: Boolean(env.NEON_PRODUCTION?.connectionString),
      },
      aiGateway: false,
      observability: false,
    });
  }

  const isLearningRoute = /^\/api\/learning(?:\/|$)/u.test(url.pathname);
  if (url.pathname !== "/api/drafts" && url.pathname !== "/api/vault" && !isLearningRoute) return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "Not found." }, 404);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Cross-origin requests are not allowed." }, 403);

  let identity;
  try {
    identity = await authenticateAccessRequest(request, env, url.hostname, options.verifyAccess);
  } catch {
    return json({ error: "DialogMint authentication is required." }, 401);
  }

  if (url.pathname === "/api/vault") return handleVaultRequest(request, env, url, identity, options);
  if (isLearningRoute) return await handleLearningRequest(request, env, url, identity, options) ?? json({ error: "Not found." }, 404);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { Allow: "POST" });

  const rate = await env.DRAFT_RATE_LIMITER.limit({ key: identity.accountId });
  if (!rate.success) return json({ error: "Draft limit reached. Wait one minute and try again." }, 429, { "Retry-After": "60" });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "Expected a JSON request." }, 415);
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return json({ error: "Request is too large." }, 413);

  let rawPayload;
  try {
    rawPayload = await request.json();
  } catch {
    return json({ error: "Request body is not valid JSON." }, 400);
  }
  let context;
  try {
    context = parseDraftPayload(rawPayload);
  } catch (error) {
    return json({ error: error instanceof Error && error.message === "oversized" ? "Draft context is too large." : "Draft context is invalid." }, error instanceof Error && error.message === "oversized" ? 413 : 400);
  }
  context = await addRetrievedLearningExamples(context, env, url, identity, options);

  const wantsStream = request.headers.get("Accept")?.toLowerCase().includes("text/event-stream");
  if (wantsStream) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        const emit = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)));
        try {
          const result = await runProviderPipeline(context, env, { ...options, signal: request.signal }, emit);
          emit("result", result);
        } catch (error) {
          emit("error", safeGenerationErrorPayload(error));
        } finally {
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { ...RESPONSE_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" },
    });
  }

  try {
    return json(await runProviderPipeline(context, env, { ...options, signal: request.signal }, () => {}));
  } catch (error) {
    return json(safeGenerationErrorPayload(error), 502);
  }
}

export function cleanupScheduledData(env, options = {}) {
  return Promise.all([
    cleanupExpiredVaults(env, options),
    cleanupExpiredLearningRecords(env, options),
  ]);
}

const worker = {
  fetch: handleRequest,
  scheduled(_controller, env, context) {
    context.waitUntil(cleanupScheduledData(env));
  },
};

export default worker;
