export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedNeurons: number;
}

export interface UsageModelSummary {
  modelId: string;
  consumedMicroUsd: number;
  quality: "exact" | "estimated" | "unavailable";
  totals: UsageTokenTotals;
}

export interface UsageProviderSummary {
  provider: "anthropic" | "workers_ai";
  consumedMicroUsd: number;
  allowanceMicroUsd: number;
  remainingMicroUsd: number;
  quality: "exact" | "estimated" | "unavailable";
  totals: UsageTokenTotals;
  models: UsageModelSummary[];
}

export interface CloudUsageSummary {
  periodStart: string;
  nextResetAt: string;
  providers: { anthropic: UsageProviderSummary; workersAi: UsageProviderSummary };
}

const QUALITY = new Set(["exact", "estimated", "unavailable"]);
const TOTAL_KEYS = [
  "uncachedInputTokens", "cacheWriteTokens", "cacheWrite5mTokens", "cacheWrite1hTokens",
  "cacheReadTokens", "outputTokens", "thinkingTokens", "promptTokens", "completionTokens",
  "totalTokens", "estimatedNeurons",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function invalidResponse(): never {
  throw new Error("DialogMint received an invalid AI usage response.");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseExactIsoTimestamp(value: unknown): string {
  if (typeof value !== "string") return invalidResponse();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return invalidResponse();
  return value;
}

function parseTotals(value: unknown): UsageTokenTotals {
  if (!isPlainObject(value) || !hasExactKeys(value, TOTAL_KEYS) || !TOTAL_KEYS.every((key) => isNonNegativeSafeInteger(value[key]))) return invalidResponse();
  return Object.fromEntries(TOTAL_KEYS.map((key) => [key, value[key]])) as UsageTokenTotals;
}

function parseModel(value: unknown): UsageModelSummary {
  if (!isPlainObject(value) || !hasExactKeys(value, ["modelId", "consumedMicroUsd", "quality", "totals"])
      || typeof value.modelId !== "string" || value.modelId.length < 1 || value.modelId.length > 200
      || !isNonNegativeSafeInteger(value.consumedMicroUsd) || typeof value.quality !== "string" || !QUALITY.has(value.quality)) return invalidResponse();
  return {
    modelId: value.modelId,
    consumedMicroUsd: value.consumedMicroUsd,
    quality: value.quality as UsageModelSummary["quality"],
    totals: parseTotals(value.totals),
  };
}

function combinedQuality(models: readonly UsageModelSummary[]): UsageProviderSummary["quality"] {
  if (!models.length || models.some((model) => model.quality === "unavailable")) return "unavailable";
  return models.some((model) => model.quality === "estimated") ? "estimated" : "exact";
}

function sumModels(models: readonly UsageModelSummary[]): { consumedMicroUsd: number; totals: UsageTokenTotals } {
  let consumedMicroUsd = 0;
  const totals = Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0])) as UsageTokenTotals;
  for (const model of models) {
    consumedMicroUsd += model.consumedMicroUsd;
    if (!Number.isSafeInteger(consumedMicroUsd)) return invalidResponse();
    for (const key of TOTAL_KEYS) {
      totals[key] += model.totals[key];
      if (!Number.isSafeInteger(totals[key])) return invalidResponse();
    }
  }
  return { consumedMicroUsd, totals };
}

function parseProvider(value: unknown, expectedProvider: UsageProviderSummary["provider"]): UsageProviderSummary {
  if (!isPlainObject(value) || !hasExactKeys(value, ["provider", "consumedMicroUsd", "allowanceMicroUsd", "remainingMicroUsd", "quality", "totals", "models"])
      || value.provider !== expectedProvider || !isNonNegativeSafeInteger(value.consumedMicroUsd)
      || !isNonNegativeSafeInteger(value.allowanceMicroUsd) || !isNonNegativeSafeInteger(value.remainingMicroUsd)
      || typeof value.quality !== "string" || !QUALITY.has(value.quality) || !Array.isArray(value.models) || value.models.length > 100) return invalidResponse();
  const remainingMicroUsd = Math.max(0, value.allowanceMicroUsd - value.consumedMicroUsd);
  if (value.remainingMicroUsd !== remainingMicroUsd) return invalidResponse();
  const models = value.models.map(parseModel);
  const totals = parseTotals(value.totals);
  const combined = sumModels(models);
  if (new Set(models.map((model) => model.modelId)).size !== models.length
      || combined.consumedMicroUsd !== value.consumedMicroUsd || combinedQuality(models) !== value.quality
      || TOTAL_KEYS.some((key) => combined.totals[key] !== totals[key])) return invalidResponse();
  return {
    provider: expectedProvider,
    consumedMicroUsd: value.consumedMicroUsd,
    allowanceMicroUsd: value.allowanceMicroUsd,
    remainingMicroUsd: value.remainingMicroUsd,
    quality: value.quality as UsageProviderSummary["quality"],
    totals,
    models,
  };
}

function validatePeriod(periodStart: string, nextResetAt: string): void {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-01T00:00:00\.000Z$/u.test(periodStart)) invalidResponse();
  const start = new Date(periodStart);
  const expectedNext = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
  if (nextResetAt !== expectedNext) invalidResponse();
}

export function parseCloudUsageSummary(value: unknown): CloudUsageSummary {
  if (!isPlainObject(value) || !hasExactKeys(value, ["periodStart", "nextResetAt", "providers"]) || !isPlainObject(value.providers)
      || !hasExactKeys(value.providers, ["anthropic", "workersAi"])) return invalidResponse();
  const periodStart = parseExactIsoTimestamp(value.periodStart);
  const nextResetAt = parseExactIsoTimestamp(value.nextResetAt);
  validatePeriod(periodStart, nextResetAt);
  return {
    periodStart,
    nextResetAt,
    providers: {
      anthropic: parseProvider(value.providers.anthropic, "anthropic"),
      workersAi: parseProvider(value.providers.workersAi, "workers_ai"),
    },
  };
}

function validMonth(value: string): boolean {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return year >= 2000 && year <= 9999 && month >= 1 && month <= 12;
}

export async function readCloudUsage(month?: string): Promise<CloudUsageSummary> {
  if (month !== undefined && !validMonth(month)) throw new Error("Usage month is invalid.");
  const path = month ? `/api/usage?month=${month}` : "/api/usage";
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok || !response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new Error("AI usage is temporarily unavailable.");
  }
  try {
    return parseCloudUsageSummary(await response.clone().json());
  } catch (error) {
    if (error instanceof Error && error.message === "AI usage is temporarily unavailable.") throw error;
    return invalidResponse();
  }
}

export function formatMicroUsd(value: number): string {
  if (!isNonNegativeSafeInteger(value)) throw new Error("AI usage amount is invalid.");
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 1_000_000);
}
