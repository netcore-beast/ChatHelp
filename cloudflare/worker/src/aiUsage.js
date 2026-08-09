import { PRICING_EFFECTIVE_DATE, PRICING_VERSION } from "./aiPricing.js";
import { queryNeon, resolveNeonContext } from "./neonDb.js";

const ACCOUNT_ID = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/u;
const PROVIDERS = new Set(["anthropic", "workers_ai"]);
const PIPELINE_STAGES = new Set(["analyzing", "drafting", "reviewing"]);
const ENVIRONMENTS = new Set(["testing", "production"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed-safe", "timed-out", "rate-limited", "cancelled"]);
const USAGE_QUALITIES = new Set(["exact", "estimated", "unavailable"]);
const PRICING_SOURCES = new Set(["published-model", "published-proxy"]);
const MAX_PRIOR_MONTHS = 12;
const RETENTION_DAYS = 365;

const USAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export const DEFAULT_ALLOWANCE_MICRO_USD = Object.freeze({
  anthropic: 10_000_000,
  workers_ai: 2_000_000,
});

class UsageRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "UsageRequestError";
    this.status = status;
  }
}

function noStoreJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...USAGE_HEADERS, ...extraHeaders },
  });
}

function requestNow(options) {
  const candidate = typeof options?.now === "function" ? options.now() : options?.now ?? new Date();
  const now = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(now.getTime())) throw new Error("invalid_usage_timestamp");
  return now;
}

function timestamp(value, fallback) {
  const candidate = value ?? fallback;
  const parsed = candidate instanceof Date ? new Date(candidate.getTime()) : new Date(candidate);
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid_usage_timestamp");
  return parsed.toISOString();
}

function boundedInteger(value, name, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid_usage:${name}`);
  return parsed;
}

function parseConfiguredMicroUsd(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value);
  if (!/^\d+$/u.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveAllowanceDefaults(env = {}) {
  return Object.freeze({
    anthropic: parseConfiguredMicroUsd(
      env.ANTHROPIC_ALLOWANCE_MICRO_USD,
      DEFAULT_ALLOWANCE_MICRO_USD.anthropic,
    ),
    workers_ai: parseConfiguredMicroUsd(
      env.WORKERS_AI_ALLOWANCE_MICRO_USD,
      DEFAULT_ALLOWANCE_MICRO_USD.workers_ai,
    ),
  });
}

function monthPeriod(month, options = {}, enforceWindow = false) {
  if (typeof month !== "string" || !MONTH.test(month)) throw new UsageRequestError("Usage month is invalid.");
  const [, yearText, monthText] = MONTH.exec(month);
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const periodStart = new Date(Date.UTC(year, monthIndex, 1));
  if (periodStart.getUTCFullYear() !== year || periodStart.getUTCMonth() !== monthIndex) {
    throw new UsageRequestError("Usage month is invalid.");
  }
  const nextReset = new Date(Date.UTC(year, monthIndex + 1, 1));
  if (enforceWindow) {
    const now = requestNow(options);
    const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const earliestStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_PRIOR_MONTHS, 1));
    if (periodStart > currentStart || periodStart < earliestStart) throw new UsageRequestError("Usage month is invalid.");
  }
  return { periodStart: periodStart.toISOString(), nextResetAt: nextReset.toISOString() };
}

function currentMonth(options) {
  const now = requestNow(options);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function queryDatabase(binding, text, values, options) {
  if (typeof options?.query === "function") return options.query(binding, text, values);
  return queryNeon(binding, text, values);
}

function validateAttemptInput(input, options) {
  const startedAt = timestamp(input?.startedAt, requestNow(options));
  if (!ACCOUNT_ID.test(input?.accountId ?? "") || !UUID.test(input?.requestId ?? "")
      || !UUID.test(input?.attemptId ?? "") || !PROVIDERS.has(input?.provider)
      || typeof input?.modelId !== "string" || !input.modelId || input.modelId.length > 200
      || !PIPELINE_STAGES.has(input?.pipelineStage) || !ENVIRONMENTS.has(input?.environment)) {
    throw new Error("invalid_usage_attempt");
  }
  return {
    accountId: input.accountId,
    requestId: input.requestId,
    attemptId: input.attemptId,
    provider: input.provider,
    modelId: input.modelId,
    pipelineStage: input.pipelineStage,
    environment: input.environment,
    startedAt,
  };
}

function freezeAttemptHandle(input) {
  return Object.freeze({ ...input });
}

async function readAllowanceAndConsumed(input, options) {
  const defaults = resolveAllowanceDefaults(options?.env);
  const { periodStart, nextResetAt } = monthPeriod(input.startedAt.slice(0, 7), options);
  const result = await queryDatabase(input.binding, `
    SELECT
      (SELECT monthly_allowance_micro_usd
       FROM dialogmint_ai_allowances
       WHERE account_id = $1 AND provider = $2) AS monthly_allowance_micro_usd,
      COALESCE(sum(estimated_cost_micro_usd) FILTER (
        WHERE status <> 'started' AND environment = $3 AND started_at >= $4 AND started_at < $5
      ), 0) AS consumed_micro_usd
    FROM dialogmint_ai_usage_attempts
    WHERE account_id = $1 AND provider = $2
  `, [input.accountId, input.provider, input.environment, periodStart, nextResetAt], options);
  const row = result?.rows?.[0] ?? {};
  const configured = boundedInteger(row.monthly_allowance_micro_usd, "allowance", defaults[input.provider]);
  const consumed = boundedInteger(row.consumed_micro_usd, "consumed", 0);
  return {
    allowanceMicroUsd: configured,
    consumedMicroUsd: consumed,
    remainingMicroUsd: Math.max(0, configured - consumed),
    nextResetAt,
  };
}

async function insertStartedAttempt(input, options) {
  const result = await queryDatabase(input.binding, `
    INSERT INTO dialogmint_ai_usage_attempts (
      account_id, request_id, attempt_id, provider, model_id, pipeline_stage, status,
      usage_quality, estimated_cost_micro_usd, pricing_version, pricing_effective_date,
      pricing_source, environment, started_at, completed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'started', 'unavailable', 0, $7, $8, 'published-model', $9, $10, NULL)
    ON CONFLICT (account_id, request_id, attempt_id) DO NOTHING
    RETURNING true AS inserted
  `, [
    input.accountId,
    input.requestId,
    input.attemptId,
    input.provider,
    input.modelId,
    input.pipelineStage,
    PRICING_VERSION,
    PRICING_EFFECTIVE_DATE,
    input.environment,
    input.startedAt,
  ], options);
  if (result?.rows?.[0]?.inserted !== true && result?.rowCount !== 1) throw new Error("usage_attempt_conflict");
}

export async function beginUsageAttempt(rawInput, options = {}) {
  const validated = validateAttemptInput(rawInput, options);
  const input = { ...validated, binding: rawInput?.binding ?? options.binding };
  const allowance = await readAllowanceAndConsumed(input, options);
  if (allowance.remainingMicroUsd <= 0) {
    return Object.freeze({ kind: "allowance-exhausted", nextResetAt: allowance.nextResetAt });
  }
  await insertStartedAttempt(input, options);
  return Object.freeze({ kind: "started", handle: freezeAttemptHandle(validated) });
}

function normalizeTerminal(terminal, options) {
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)
      || !TERMINAL_STATUSES.has(terminal.status) || !terminal.usage
      || typeof terminal.usage !== "object" || Array.isArray(terminal.usage)) {
    throw new Error("invalid_usage_terminal");
  }
  const usage = terminal.usage;
  const quality = usage.quality;
  const pricingSource = usage.pricingSource ?? "published-model";
  if (!USAGE_QUALITIES.has(quality) || !PRICING_SOURCES.has(pricingSource)) throw new Error("invalid_usage_terminal");
  const cacheWrite5mTokens = boundedInteger(usage.cacheWrite5mTokens, "cache_write_5m_tokens", 0);
  const cacheWrite1hTokens = boundedInteger(usage.cacheWrite1hTokens, "cache_write_1h_tokens", 0);
  const completedAtWasProvided = Object.prototype.hasOwnProperty.call(terminal, "completedAt");
  const completedAt = timestamp(terminal.completedAt, requestNow(options));
  return Object.freeze({
    status: terminal.status,
    usageQuality: quality,
    uncachedInputTokens: boundedInteger(usage.uncachedInputTokens ?? usage.inputTokens, "uncached_input_tokens", null),
    cacheWriteTokens: boundedInteger(usage.cacheWriteTokens, "cache_write_tokens", cacheWrite5mTokens + cacheWrite1hTokens),
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheReadTokens: boundedInteger(usage.cacheReadTokens, "cache_read_tokens", 0),
    outputTokens: boundedInteger(usage.outputTokens, "output_tokens", null),
    thinkingTokens: boundedInteger(usage.thinkingTokens, "thinking_tokens", 0),
    promptTokens: boundedInteger(usage.promptTokens, "prompt_tokens", null),
    completionTokens: boundedInteger(usage.completionTokens, "completion_tokens", null),
    totalTokens: boundedInteger(usage.totalTokens, "total_tokens", null),
    estimatedNeurons: boundedInteger(usage.estimatedNeurons, "estimated_neurons", null),
    estimatedCostMicroUsd: boundedInteger(usage.estimatedCostMicroUsd, "estimated_cost_micro_usd", 0),
    pricingVersion: typeof usage.pricingVersion === "string" && usage.pricingVersion ? usage.pricingVersion : PRICING_VERSION,
    estimatorVersion: usage.estimatorVersion === null || usage.estimatorVersion === undefined
      ? null
      : typeof usage.estimatorVersion === "string" && usage.estimatorVersion ? usage.estimatorVersion : (() => { throw new Error("invalid_usage_terminal"); })(),
    pricingSource,
    completedAt,
    completedAtWasProvided,
  });
}

const TERMINAL_ROW_FIELDS = [
  ["status", "status"],
  ["usage_quality", "usageQuality"],
  ["uncached_input_tokens", "uncachedInputTokens"],
  ["cache_write_tokens", "cacheWriteTokens"],
  ["cache_write_5m_tokens", "cacheWrite5mTokens"],
  ["cache_write_1h_tokens", "cacheWrite1hTokens"],
  ["cache_read_tokens", "cacheReadTokens"],
  ["output_tokens", "outputTokens"],
  ["thinking_tokens", "thinkingTokens"],
  ["prompt_tokens", "promptTokens"],
  ["completion_tokens", "completionTokens"],
  ["total_tokens", "totalTokens"],
  ["estimated_neurons", "estimatedNeurons"],
  ["estimated_cost_micro_usd", "estimatedCostMicroUsd"],
  ["pricing_version", "pricingVersion"],
  ["estimator_version", "estimatorVersion"],
  ["pricing_source", "pricingSource"],
];

function terminalRowMatches(row, terminal) {
  return TERMINAL_ROW_FIELDS.every(([column, field]) => {
    const actual = row?.[column] ?? null;
    const expected = terminal[field] ?? null;
    if (typeof expected === "number") {
      try {
        return boundedInteger(actual, column, null) === expected;
      } catch {
        return false;
      }
    }
    return actual === expected;
  }) && (!terminal.completedAtWasProvided || (() => {
    try {
      return timestamp(row?.completed_at) === terminal.completedAt;
    } catch {
      return false;
    }
  })());
}

async function updateTerminalAttempt(handle, terminal, options) {
  const result = await queryDatabase(options.binding, `
    WITH updated AS (
      UPDATE dialogmint_ai_usage_attempts
      SET status = $4,
          usage_quality = $5,
          uncached_input_tokens = $6,
          cache_write_tokens = $7,
          cache_write_5m_tokens = $8,
          cache_write_1h_tokens = $9,
          cache_read_tokens = $10,
          output_tokens = $11,
          thinking_tokens = $12,
          prompt_tokens = $13,
          completion_tokens = $14,
          total_tokens = $15,
          estimated_neurons = $16,
          estimated_cost_micro_usd = $17,
          pricing_version = $18,
          estimator_version = $19,
          pricing_source = $20,
          completed_at = $21
      WHERE account_id = $1 AND request_id = $2 AND attempt_id = $3 AND status = 'started'
      RETURNING *
    )
    SELECT * FROM updated
    UNION ALL
    SELECT * FROM dialogmint_ai_usage_attempts
    WHERE account_id = $1 AND request_id = $2 AND attempt_id = $3
      AND NOT EXISTS (SELECT 1 FROM updated)
    LIMIT 1
  `, [
    handle.accountId,
    handle.requestId,
    handle.attemptId,
    terminal.status,
    terminal.usageQuality,
    terminal.uncachedInputTokens,
    terminal.cacheWriteTokens,
    terminal.cacheWrite5mTokens,
    terminal.cacheWrite1hTokens,
    terminal.cacheReadTokens,
    terminal.outputTokens,
    terminal.thinkingTokens,
    terminal.promptTokens,
    terminal.completionTokens,
    terminal.totalTokens,
    terminal.estimatedNeurons,
    terminal.estimatedCostMicroUsd,
    terminal.pricingVersion,
    terminal.estimatorVersion,
    terminal.pricingSource,
    terminal.completedAt,
  ], options);
  const row = result?.rows?.[0];
  if (!row) throw new Error("usage_attempt_not_found");
  if (!terminalRowMatches(row, terminal)) throw new Error("usage_terminal_conflict");
}

function validateAttemptHandle(handle) {
  return validateAttemptInput(handle, { now: handle?.startedAt });
}

function retryTerminalAttemptOnce(handle, terminal, options) {
  const retryOptions = Object.freeze({ binding: options.binding, query: options.query });
  return updateTerminalAttempt(handle, terminal, retryOptions).catch(() => undefined);
}

export async function finishUsageAttempt(rawHandle, rawTerminal, options = {}) {
  const handle = validateAttemptHandle(rawHandle);
  const terminal = normalizeTerminal(rawTerminal, options);
  try {
    await updateTerminalAttempt(handle, terminal, options);
    return "recorded";
  } catch (error) {
    if (error instanceof Error && ["usage_terminal_conflict", "usage_attempt_not_found"].includes(error.message)) throw error;
    if (typeof options.executionContext?.waitUntil !== "function") throw error;
    options.executionContext.waitUntil(retryTerminalAttemptOnce(handle, terminal, options));
    return "pending";
  }
}

const TOTAL_FIELDS = Object.freeze([
  ["uncached_input_tokens", "uncachedInputTokens"],
  ["cache_write_tokens", "cacheWriteTokens"],
  ["cache_write_5m_tokens", "cacheWrite5mTokens"],
  ["cache_write_1h_tokens", "cacheWrite1hTokens"],
  ["cache_read_tokens", "cacheReadTokens"],
  ["output_tokens", "outputTokens"],
  ["thinking_tokens", "thinkingTokens"],
  ["prompt_tokens", "promptTokens"],
  ["completion_tokens", "completionTokens"],
  ["total_tokens", "totalTokens"],
  ["estimated_neurons", "estimatedNeurons"],
]);

function emptyTotals() {
  return Object.fromEntries(TOTAL_FIELDS.map(([, field]) => [field, 0]));
}

function totalsFromRow(row) {
  return Object.fromEntries(TOTAL_FIELDS.map(([column, field]) => [field, boundedInteger(row?.[column], column, 0)]));
}

function addTotals(target, addition) {
  for (const [, field] of TOTAL_FIELDS) target[field] += addition[field];
}

function aggregateQuality(qualities) {
  if (!qualities.length || qualities.includes("unavailable")) return "unavailable";
  return qualities.includes("estimated") ? "estimated" : "exact";
}

function providerSummary(provider, rows, defaultAllowance) {
  const totals = emptyTotals();
  const models = [];
  let allowanceMicroUsd = defaultAllowance;
  let consumedMicroUsd = 0;
  const qualities = [];
  for (const row of rows) {
    if (row.provider !== provider) throw new Error("invalid_stored_usage");
    if (row.monthly_allowance_micro_usd !== null && row.monthly_allowance_micro_usd !== undefined) {
      const override = boundedInteger(row.monthly_allowance_micro_usd, "allowance", defaultAllowance);
      if (allowanceMicroUsd !== defaultAllowance && allowanceMicroUsd !== override) throw new Error("invalid_stored_usage");
      allowanceMicroUsd = override;
    }
    if (row.model_id === null || row.model_id === undefined) continue;
    if (typeof row.model_id !== "string" || !row.model_id) throw new Error("invalid_stored_usage");
    if (!USAGE_QUALITIES.has(row.usage_quality)) throw new Error("invalid_stored_usage");
    const modelTotals = totalsFromRow(row);
    const modelCost = boundedInteger(row.consumed_micro_usd, "consumed", 0);
    addTotals(totals, modelTotals);
    consumedMicroUsd += modelCost;
    if (!Number.isSafeInteger(consumedMicroUsd)) throw new Error("invalid_stored_usage");
    qualities.push(row.usage_quality);
    models.push({
      modelId: row.model_id,
      consumedMicroUsd: modelCost,
      quality: row.usage_quality,
      totals: modelTotals,
    });
  }
  return {
    provider,
    consumedMicroUsd,
    allowanceMicroUsd,
    remainingMicroUsd: Math.max(0, allowanceMicroUsd - consumedMicroUsd),
    quality: aggregateQuality(qualities),
    totals,
    models,
  };
}

export async function getUsageSummary(binding, accountId, month, options = {}) {
  if (!ACCOUNT_ID.test(accountId ?? "")) throw new Error("invalid_usage_account");
  const environment = options.environment ?? "testing";
  if (!ENVIRONMENTS.has(environment)) throw new Error("invalid_usage_environment");
  const selectedMonth = month ?? currentMonth(options);
  const period = monthPeriod(selectedMonth, options, true);
  const result = await queryDatabase(binding, `
    WITH providers(provider) AS (
      VALUES ('anthropic'::text), ('workers_ai'::text)
    ), monthly_attempts AS (
      SELECT
        provider,
        model_id,
        CASE
          WHEN bool_or(usage_quality = 'unavailable') THEN 'unavailable'
          WHEN bool_or(usage_quality = 'estimated') THEN 'estimated'
          ELSE 'exact'
        END AS usage_quality,
        COALESCE(sum(uncached_input_tokens), 0) AS uncached_input_tokens,
        COALESCE(sum(cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(sum(cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
        COALESCE(sum(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
        COALESCE(sum(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(sum(output_tokens), 0) AS output_tokens,
        COALESCE(sum(thinking_tokens), 0) AS thinking_tokens,
        COALESCE(sum(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(sum(completion_tokens), 0) AS completion_tokens,
        COALESCE(sum(total_tokens), 0) AS total_tokens,
        COALESCE(sum(estimated_neurons), 0) AS estimated_neurons,
        COALESCE(sum(estimated_cost_micro_usd), 0) AS consumed_micro_usd
      FROM dialogmint_ai_usage_attempts
      WHERE account_id = $1
        AND environment = $2
        AND started_at >= $3
        AND started_at < $4
        AND status <> 'started'
      GROUP BY provider, model_id
    )
    SELECT
      providers.provider,
      monthly_attempts.model_id,
      allowance.monthly_allowance_micro_usd,
      monthly_attempts.usage_quality,
      COALESCE(monthly_attempts.uncached_input_tokens, 0) AS uncached_input_tokens,
      COALESCE(monthly_attempts.cache_write_tokens, 0) AS cache_write_tokens,
      COALESCE(monthly_attempts.cache_write_5m_tokens, 0) AS cache_write_5m_tokens,
      COALESCE(monthly_attempts.cache_write_1h_tokens, 0) AS cache_write_1h_tokens,
      COALESCE(monthly_attempts.cache_read_tokens, 0) AS cache_read_tokens,
      COALESCE(monthly_attempts.output_tokens, 0) AS output_tokens,
      COALESCE(monthly_attempts.thinking_tokens, 0) AS thinking_tokens,
      COALESCE(monthly_attempts.prompt_tokens, 0) AS prompt_tokens,
      COALESCE(monthly_attempts.completion_tokens, 0) AS completion_tokens,
      COALESCE(monthly_attempts.total_tokens, 0) AS total_tokens,
      COALESCE(monthly_attempts.estimated_neurons, 0) AS estimated_neurons,
      COALESCE(monthly_attempts.consumed_micro_usd, 0) AS consumed_micro_usd
    FROM providers
    LEFT JOIN dialogmint_ai_allowances AS allowance
      ON allowance.account_id = $1 AND allowance.provider = providers.provider
    LEFT JOIN monthly_attempts ON monthly_attempts.provider = providers.provider
    ORDER BY providers.provider, monthly_attempts.model_id
  `, [accountId, environment, period.periodStart, period.nextResetAt], options);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const defaults = resolveAllowanceDefaults(options.env);
  return {
    periodStart: period.periodStart,
    nextResetAt: period.nextResetAt,
    providers: {
      anthropic: providerSummary("anthropic", rows.filter((row) => row.provider === "anthropic"), defaults.anthropic),
      workersAi: providerSummary("workers_ai", rows.filter((row) => row.provider === "workers_ai"), defaults.workers_ai),
    },
  };
}

function usageErrorResponse(error) {
  if (error instanceof UsageRequestError) return noStoreJson({ error: error.message }, error.status);
  return noStoreJson({ error: "AI usage is temporarily unavailable." }, 503);
}

export async function handleUsageRequest(request, env, url, identity, options = {}) {
  if (url.pathname !== "/api/usage") return null;
  let neonContext;
  try {
    neonContext = resolveNeonContext(env, url.hostname);
  } catch {
    return noStoreJson({ error: "AI usage is unavailable." }, 503);
  }
  if (identity?.environment !== neonContext.environment || !ACCOUNT_ID.test(identity?.accountId ?? "")) {
    return noStoreJson({ error: "AI usage is unavailable." }, 503);
  }

  let rate;
  try {
    rate = await env.DRAFT_RATE_LIMITER.limit({ key: `usage:${identity.accountId}` });
  } catch {
    return noStoreJson({ error: "AI usage is temporarily unavailable." }, 503);
  }
  if (!rate?.success) return noStoreJson({ error: "Please wait before trying again." }, 429, { "Retry-After": "60" });
  if (request.headers.has("X-Account-Id") || request.headers.has("X-User-Email")) {
    return noStoreJson({ error: "Browser account identifiers are not accepted." }, 400);
  }
  if (request.method !== "GET") return noStoreJson({ error: "Method not allowed." }, 405, { Allow: "GET" });

  try {
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== "month") || url.searchParams.getAll("month").length > 1) {
      throw new UsageRequestError("Usage query is invalid.");
    }
    const month = url.searchParams.get("month") ?? currentMonth(options);
    return noStoreJson(await getUsageSummary(neonContext.binding, identity.accountId, month, {
      ...options,
      env,
      environment: neonContext.environment,
    }));
  } catch (error) {
    return usageErrorResponse(error);
  }
}

function safeRowCount(value) {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export async function cleanupExpiredUsageAttempts(env, options = {}) {
  const environment = env.DEPLOYMENT_ENVIRONMENT;
  const binding = environment === "testing" ? env.NEON_TESTING : environment === "production" ? env.NEON_PRODUCTION : null;
  if (!ENVIRONMENTS.has(environment) || !binding?.connectionString) return 0;
  const cutoff = new Date(requestNow(options).getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  try {
    const result = await queryDatabase(binding, `
      DELETE FROM dialogmint_ai_usage_attempts
      WHERE environment = $1 AND started_at < $2
    `, [environment, cutoff], options);
    return safeRowCount(result?.rowCount);
  } catch {
    return 0;
  }
}
