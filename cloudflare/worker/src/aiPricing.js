export const PRICING_VERSION = "2026-08-09-v1";
export const PRICING_EFFECTIVE_DATE = "2026-08-09";
export const ESTIMATOR_VERSION = "characters-over-four-v1";
export const MAX_USAGE_TOKENS = 100_000_000;

export const PRICE_MICRO_USD_PER_MILLION = Object.freeze({
  "anthropic:claude-opus-4-6": Object.freeze({
    uncachedInput: 5_000_000,
    cacheWrite5m: 6_250_000,
    cacheWrite1h: 10_000_000,
    cacheRead: 500_000,
    output: 25_000_000,
    source: "published-model",
  }),
  "workers_ai:@cf/openai/gpt-oss-120b": Object.freeze({
    input: 350_000,
    output: 750_000,
    source: "published-model",
  }),
  "workers_ai:@cf/meta/llama-3.1-8b-instruct-fast": Object.freeze({
    input: 45_000,
    output: 384_000,
    source: "published-proxy",
  }),
});

const TOKENS_PER_MILLION = 1_000_000n;

function invalidUsage(name) {
  throw new Error(`invalid_usage:${name}`);
}

function assertUsageTokens(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_USAGE_TOKENS) invalidUsage(name);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalUsageNumber(record, names, name) {
  if (!isRecord(record)) return null;
  for (const field of names) {
    if (Object.prototype.hasOwnProperty.call(record, field) && record[field] !== undefined) {
      return assertUsageTokens(record[field], name);
    }
  }
  return null;
}

function requiredOrZero(record, names, name) {
  return optionalUsageNumber(record, names, name) ?? 0;
}

function priceFor(provider, modelId) {
  const price = PRICE_MICRO_USD_PER_MILLION[`${provider}:${modelId}`];
  if (!price) throw new Error("unsupported_pricing_model");
  return price;
}

function roundedMicroUsd(tokens, microUsdPerMillion) {
  const numerator = BigInt(tokens) * BigInt(microUsdPerMillion);
  return (numerator + TOKENS_PER_MILLION - 1n) / TOKENS_PER_MILLION;
}

function numberFromMicroUsd(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("usage_cost_out_of_bounds");
  return Number(value);
}

function sumPrices(parts) {
  return numberFromMicroUsd(parts.reduce((total, part) => total + part, 0n));
}

function normalizedCostUsage(usage) {
  return {
    inputTokens: assertUsageTokens(usage?.inputTokens ?? 0, "input_tokens"),
    outputTokens: assertUsageTokens(usage?.outputTokens ?? 0, "output_tokens"),
    cacheWrite5mTokens: assertUsageTokens(usage?.cacheWrite5mTokens ?? 0, "cache_write_5m_tokens"),
    cacheWrite1hTokens: assertUsageTokens(usage?.cacheWrite1hTokens ?? 0, "cache_write_1h_tokens"),
    cacheReadTokens: assertUsageTokens(usage?.cacheReadTokens ?? 0, "cache_read_tokens"),
  };
}

export function estimateTokensV1(text) {
  const estimated = Math.ceil(String(text ?? "").normalize("NFKC").length / 4);
  return Math.min(MAX_USAGE_TOKENS, Math.max(0, estimated));
}

export function calculateEstimatedCostMicroUsd(usage, provider, modelId) {
  const normalized = normalizedCostUsage(usage);
  const price = priceFor(provider, modelId);
  if (provider === "anthropic") {
    return sumPrices([
      roundedMicroUsd(normalized.inputTokens, price.uncachedInput),
      roundedMicroUsd(normalized.cacheWrite5mTokens, price.cacheWrite5m),
      roundedMicroUsd(normalized.cacheWrite1hTokens, price.cacheWrite1h),
      roundedMicroUsd(normalized.cacheReadTokens, price.cacheRead),
      roundedMicroUsd(normalized.outputTokens, price.output),
    ]);
  }
  if (provider === "workers_ai") {
    return sumPrices([
      roundedMicroUsd(normalized.inputTokens, price.input),
      roundedMicroUsd(normalized.outputTokens, price.output),
    ]);
  }
  throw new Error("unsupported_pricing_model");
}

function pricedUsage(usage, provider, modelId, quality, estimatorVersion = null) {
  const price = priceFor(provider, modelId);
  return Object.freeze({
    ...usage,
    quality,
    pricingSource: price.source,
    pricingVersion: PRICING_VERSION,
    estimatorVersion,
    estimatedCostMicroUsd: calculateEstimatedCostMicroUsd(usage, provider, modelId),
  });
}

export function normalizeAnthropicUsage(payload) {
  const usage = isRecord(payload) ? payload : {};
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : {};
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const outputTokens = requiredOrZero(usage, ["output_tokens", "outputTokens"], "output_tokens");
  const thinkingTokens = requiredOrZero(outputDetails, ["thinking_tokens", "thinkingTokens"], "thinking_tokens");
  if (thinkingTokens > outputTokens) invalidUsage("thinking_tokens");

  return pricedUsage({
    inputTokens: requiredOrZero(usage, ["input_tokens", "inputTokens"], "input_tokens"),
    cacheWrite5mTokens: requiredOrZero(cacheCreation, ["ephemeral_5m_input_tokens"], "cache_write_5m_tokens"),
    cacheWrite1hTokens: requiredOrZero(cacheCreation, ["ephemeral_1h_input_tokens"], "cache_write_1h_tokens"),
    cacheReadTokens: requiredOrZero(usage, ["cache_read_input_tokens", "cacheReadInputTokens"], "cache_read_tokens"),
    outputTokens,
    thinkingTokens,
  }, "anthropic", "claude-opus-4-6", "exact");
}

function workersUsageRecord(result) {
  if (isRecord(result?.usage)) return result.usage;
  return isRecord(result) ? result : {};
}

function exactOrEstimated(usage, fields, fieldName, text) {
  const exact = optionalUsageNumber(usage, fields, fieldName);
  return exact === null ? { value: estimateTokensV1(text), exact: false } : { value: exact, exact: true };
}

export function normalizeWorkersAiUsage(result, context = {}) {
  const modelId = context.modelId;
  const usage = workersUsageRecord(result);
  const input = exactOrEstimated(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"], "input_tokens", context.normalizedInputText);
  const output = exactOrEstimated(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"], "output_tokens", context.normalizedOutputText);
  const quality = input.exact && output.exact ? "exact" : "estimated";

  return pricedUsage({
    inputTokens: input.value,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    outputTokens: output.value,
    thinkingTokens: 0,
    promptTokens: optionalUsageNumber(usage, ["prompt_tokens", "promptTokens"], "prompt_tokens"),
    completionTokens: optionalUsageNumber(usage, ["completion_tokens", "completionTokens"], "completion_tokens"),
    totalTokens: optionalUsageNumber(usage, ["total_tokens", "totalTokens"], "total_tokens"),
    estimatedNeurons: optionalUsageNumber(usage, ["estimated_neurons", "estimatedNeurons", "neurons"], "estimated_neurons"),
  }, "workers_ai", modelId, quality, quality === "exact" ? null : ESTIMATOR_VERSION);
}
