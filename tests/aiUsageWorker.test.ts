import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ALLOWANCE_MICRO_USD,
  beginUsageAttempt,
  cleanupExpiredUsageAttempts,
  finishUsageAttempt,
  getUsageSummary,
  handleUsageRequest,
  resolveAllowanceDefaults,
} from "../cloudflare/worker/src/aiUsage.js";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const TESTING_ORIGIN = `https://${TESTING_HOST}`;
const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-09T12:00:00.000Z");
const binding = { connectionString: "synthetic-testing-binding" };

const validAttempt = {
  binding,
  accountId: ACCOUNT_A,
  requestId: REQUEST_ID,
  attemptId: ATTEMPT_ID,
  provider: "anthropic",
  modelId: "claude-opus-4-6",
  pipelineStage: "analyzing",
  environment: "testing",
  startedAt: NOW.toISOString(),
};

const succeededUsage = {
  status: "succeeded",
  usage: {
    quality: "exact",
    inputTokens: 100,
    cacheWrite5mTokens: 10,
    cacheWrite1hTokens: 20,
    cacheReadTokens: 30,
    outputTokens: 50,
    thinkingTokens: 5,
    estimatedCostMicroUsd: 2_000,
    pricingVersion: "2026-08-09-v1",
    estimatorVersion: null,
    pricingSource: "published-model",
  },
};

function env(overrides: Record<string, unknown> = {}) {
  return {
    DEPLOYMENT_ENVIRONMENT: "testing",
    NEON_TESTING: binding,
    NEON_PRODUCTION: { connectionString: "synthetic-production-binding" },
    DRAFT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...overrides,
  };
}

function terminalRow(terminal = succeededUsage) {
  return {
    status: terminal.status,
    usage_quality: terminal.usage.quality,
    uncached_input_tokens: terminal.usage.inputTokens,
    cache_write_tokens: terminal.usage.cacheWrite5mTokens + terminal.usage.cacheWrite1hTokens,
    cache_write_5m_tokens: terminal.usage.cacheWrite5mTokens,
    cache_write_1h_tokens: terminal.usage.cacheWrite1hTokens,
    cache_read_tokens: terminal.usage.cacheReadTokens,
    output_tokens: terminal.usage.outputTokens,
    thinking_tokens: terminal.usage.thinkingTokens,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    estimated_neurons: null,
    estimated_cost_micro_usd: terminal.usage.estimatedCostMicroUsd,
    pricing_version: terminal.usage.pricingVersion,
    estimator_version: terminal.usage.estimatorVersion,
    pricing_source: terminal.usage.pricingSource,
    completed_at: NOW.toISOString(),
  };
}

function summaryModelRow(provider: "anthropic" | "workers_ai", overrides: Record<string, unknown> = {}) {
  return {
    provider,
    model_id: provider === "anthropic" ? "claude-opus-4-6" : "@cf/openai/gpt-oss-120b",
    monthly_allowance_micro_usd: null,
    usage_quality: "exact",
    uncached_input_tokens: "0",
    cache_write_tokens: "0",
    cache_write_5m_tokens: "0",
    cache_write_1h_tokens: "0",
    cache_read_tokens: "0",
    output_tokens: "0",
    thinking_tokens: "0",
    prompt_tokens: "0",
    completion_tokens: "0",
    total_tokens: "0",
    estimated_neurons: "0",
    consumed_micro_usd: "0",
    ...overrides,
  };
}

describe("server-authoritative AI usage ledger", () => {
  it("permits one started-to-terminal transition and an identical retry", async () => {
    let storedTerminal: ReturnType<typeof terminalRow> | null = null;
    const query = vi.fn(async (_binding: unknown, sql: string) => {
      if (/SELECT[\s\S]+monthly_allowance_micro_usd/iu.test(sql)) {
        return { rows: [{ monthly_allowance_micro_usd: null, consumed_micro_usd: "0", started_attempts: "0", inserted: true }] };
      }
      if (/INSERT INTO dialogmint_ai_usage_attempts/iu.test(sql)) return { rows: [{ inserted: true }], rowCount: 1 };
      if (/UPDATE dialogmint_ai_usage_attempts/iu.test(sql)) {
        if (!storedTerminal) storedTerminal = terminalRow();
        return { rows: [storedTerminal], rowCount: 1 };
      }
      throw new Error("unexpected query");
    });

    const started = await beginUsageAttempt(validAttempt, { query });
    expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error("Expected a started handle");
    expect(await finishUsageAttempt(started.handle, succeededUsage, { query, now: NOW })).toBe("recorded");
    expect(await finishUsageAttempt(started.handle, succeededUsage, {
      query,
      now: new Date("2026-08-09T12:00:01.000Z"),
    })).toBe("recorded");
    await expect(finishUsageAttempt(started.handle, {
      ...succeededUsage,
      usage: { ...succeededUsage.usage, estimatedCostMicroUsd: 2_001 },
    }, { query, now: NOW })).rejects.toThrow("usage_terminal_conflict");
  });

  it("does not insert a started row after the app allowance is consumed", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ monthly_allowance_micro_usd: "100", consumed_micro_usd: "100", started_attempts: "0", inserted: false }],
    });

    await expect(beginUsageAttempt(validAttempt, { query, now: NOW })).resolves.toEqual({
      kind: "allowance-exhausted",
      nextResetAt: "2026-09-01T00:00:00.000Z",
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("fails closed without inserting a started attempt when the allowance aggregate is missing or malformed", async () => {
    for (const result of [{ rows: [] }, { rows: [{ monthly_allowance_micro_usd: null }] }]) {
      const query = vi.fn().mockResolvedValue(result);
      await expect(beginUsageAttempt(validAttempt, { query, now: NOW })).rejects.toThrow("usage_allowance_unavailable");
      expect(query).toHaveBeenCalledTimes(1);
    }
  });

  it("fails closed when an atomic allowance admission sees an in-flight attempt", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      monthly_allowance_micro_usd: "100",
      consumed_micro_usd: "0",
      started_attempts: "1",
      inserted: false,
    }] });
    await expect(beginUsageAttempt(validAttempt, { query, now: NOW })).resolves.toEqual({
      kind: "allowance-unavailable",
      nextResetAt: "2026-09-01T00:00:00.000Z",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toMatch(/pg_advisory_xact_lock/u);
  });

  it("blocks a lingering started attempt across a billing-month boundary", async () => {
    const septemberAttempt = { ...validAttempt, attemptId: "33333333-3333-4333-8333-333333333333", startedAt: "2026-09-01T00:00:00.000Z" };
    const query = vi.fn(async (_binding: unknown, sql: string) => {
      const startedAttemptFilter = sql.match(/count\(\*\) FILTER \([\s\S]*?\) AS started_attempts/u)?.[0] ?? "";
      const incorrectlyScopesToSeptember = startedAttemptFilter.includes("started_at >= $4");
      return { rows: [{
        monthly_allowance_micro_usd: "100",
        consumed_micro_usd: "0",
        started_attempts: incorrectlyScopesToSeptember ? "0" : "1",
        inserted: !incorrectlyScopesToSeptember,
      }] };
    });

    await expect(beginUsageAttempt(septemberAttempt, { query, now: new Date("2026-09-01T00:00:00.000Z") })).resolves.toEqual({
      kind: "allowance-unavailable",
      nextResetAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("rejects incomplete exact and estimated terminal accounting before a database write", async () => {
    const query = vi.fn();
    const handle = Object.freeze({ ...validAttempt });
    await expect(finishUsageAttempt(handle, {
      ...succeededUsage,
      usage: { ...succeededUsage.usage, estimatedCostMicroUsd: undefined },
    }, { query, now: NOW })).rejects.toThrow("invalid_usage_terminal");
    await expect(finishUsageAttempt(handle, {
      ...succeededUsage,
      usage: { ...succeededUsage.usage, quality: "estimated", estimatorVersion: null },
    }, { query, now: NOW })).rejects.toThrow("invalid_usage_terminal");
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects terminal token invariants and tokens above the pricing ceiling before a database write", async () => {
    const query = vi.fn();
    const handle = Object.freeze({ ...validAttempt });
    for (const usage of [
      { ...succeededUsage.usage, thinkingTokens: 51 },
      { ...succeededUsage.usage, cacheWriteTokens: 31 },
      { ...succeededUsage.usage, outputTokens: 100_000_001 },
      { ...succeededUsage.usage, estimatedNeurons: 100_000_001 },
    ]) {
      await expect(finishUsageAttempt(handle, { ...succeededUsage, usage }, { query, now: NOW })).rejects.toThrow("invalid_usage_terminal");
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("uses approved bounded defaults and ignores malformed configured values", () => {
    expect(DEFAULT_ALLOWANCE_MICRO_USD).toEqual({ anthropic: 10_000_000, workers_ai: 2_000_000 });
    expect(resolveAllowanceDefaults({
      ANTHROPIC_ALLOWANCE_MICRO_USD: "1234567",
      WORKERS_AI_ALLOWANCE_MICRO_USD: "-1",
    })).toEqual({ anthropic: 1_234_567, workers_ai: 2_000_000 });
    expect(resolveAllowanceDefaults({
      ANTHROPIC_ALLOWANCE_MICRO_USD: "1.5",
      WORKERS_AI_ALLOWANCE_MICRO_USD: String(Number.MAX_SAFE_INTEGER + 1),
    })).toEqual(DEFAULT_ALLOWANCE_MICRO_USD);
  });

  it("uses account overrides, separate provider/model totals, and a UTC calendar boundary", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      {
        provider: "anthropic",
        model_id: "claude-opus-4-6",
        monthly_allowance_micro_usd: "12000000",
        usage_quality: "exact",
        uncached_input_tokens: "100",
        cache_write_tokens: "30",
        cache_write_5m_tokens: "10",
        cache_write_1h_tokens: "20",
        cache_read_tokens: "40",
        output_tokens: "50",
        thinking_tokens: "5",
        prompt_tokens: "0",
        completion_tokens: "0",
        total_tokens: "0",
        estimated_neurons: "0",
        consumed_micro_usd: "2500000",
      },
      {
        provider: "workers_ai",
        model_id: "@cf/openai/gpt-oss-120b",
        monthly_allowance_micro_usd: null,
        usage_quality: "estimated",
        uncached_input_tokens: "9",
        cache_write_tokens: "0",
        cache_write_5m_tokens: "0",
        cache_write_1h_tokens: "0",
        cache_read_tokens: "0",
        output_tokens: "7",
        thinking_tokens: "0",
        prompt_tokens: "9",
        completion_tokens: "7",
        total_tokens: "16",
        estimated_neurons: "0",
        consumed_micro_usd: "500000",
      },
    ] });

    const summary = await getUsageSummary(binding, ACCOUNT_A, "2026-08", {
      query,
      environment: "testing",
      now: () => new Date("2026-08-31T23:59:59.000Z"),
    });

    expect(summary.periodStart).toBe("2026-08-01T00:00:00.000Z");
    expect(summary.nextResetAt).toBe("2026-09-01T00:00:00.000Z");
    expect(summary.providers.anthropic).toMatchObject({
      provider: "anthropic",
      allowanceMicroUsd: 12_000_000,
      consumedMicroUsd: 2_500_000,
      remainingMicroUsd: 9_500_000,
      quality: "exact",
      models: [{ modelId: "claude-opus-4-6", consumedMicroUsd: 2_500_000, quality: "exact" }],
    });
    expect(summary.providers.workersAi).toMatchObject({
      provider: "workers_ai",
      allowanceMicroUsd: 2_000_000,
      consumedMicroUsd: 500_000,
      remainingMicroUsd: 1_500_000,
      quality: "estimated",
      models: [{ modelId: "@cf/openai/gpt-oss-120b", consumedMicroUsd: 500_000, quality: "estimated" }],
    });
    expect(query.mock.calls[0][2]).toEqual([
      ACCOUNT_A,
      "testing",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
  });

  it("marks a provider unavailable while started accounting is pending instead of claiming exact usage", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      provider: "anthropic",
      model_id: "claude-opus-4-6",
      monthly_allowance_micro_usd: null,
      usage_quality: "unavailable",
      uncached_input_tokens: "0",
      cache_write_tokens: "0",
      cache_write_5m_tokens: "0",
      cache_write_1h_tokens: "0",
      cache_read_tokens: "0",
      output_tokens: "0",
      thinking_tokens: "0",
      prompt_tokens: "0",
      completion_tokens: "0",
      total_tokens: "0",
      estimated_neurons: "0",
      consumed_micro_usd: "0",
    }, {
      provider: "workers_ai",
      model_id: null,
      monthly_allowance_micro_usd: null,
    }] });
    const summary = await getUsageSummary(binding, ACCOUNT_A, "2026-08", { query, environment: "testing", now: NOW });
    expect(summary.providers.anthropic.quality).toBe("unavailable");
    expect(query.mock.calls[0][1]).toMatch(/bool_or\(status = 'started' OR usage_quality = 'unavailable'\)/u);
    expect(query.mock.calls[0][1]).not.toContain("status <> 'started'");
  });

  it("rejects unsafe aggregate totals and server summaries beyond the client model limits", async () => {
    const row = {
      provider: "anthropic",
      monthly_allowance_micro_usd: null,
      usage_quality: "exact",
      uncached_input_tokens: String(Number.MAX_SAFE_INTEGER),
      cache_write_tokens: "0",
      cache_write_5m_tokens: "0",
      cache_write_1h_tokens: "0",
      cache_read_tokens: "0",
      output_tokens: "0",
      thinking_tokens: "0",
      prompt_tokens: "0",
      completion_tokens: "0",
      total_tokens: "0",
      estimated_neurons: "0",
      consumed_micro_usd: "0",
    };
    for (const rows of [
      [{ ...row, model_id: "claude-opus-4-6" }, { ...row, model_id: "claude-opus-4-6" }],
      Array.from({ length: 101 }, (_, index) => ({ ...row, uncached_input_tokens: "0", model_id: `model-${index}` })),
      [{ ...row, uncached_input_tokens: "0", model_id: "m".repeat(201) }],
    ]) {
      await expect(getUsageSummary(binding, ACCOUNT_A, "2026-08", {
        query: vi.fn().mockResolvedValue({ rows }), environment: "testing", now: NOW,
      })).rejects.toThrow("invalid_stored_usage");
    }
  });

  it("reports unavailable quality when no terminal usage exists", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { provider: "anthropic", model_id: null, monthly_allowance_micro_usd: null },
      { provider: "workers_ai", model_id: null, monthly_allowance_micro_usd: null },
    ] });
    const summary = await getUsageSummary(binding, ACCOUNT_A, "2026-08", { query, environment: "testing", now: NOW });
    expect(summary.providers.anthropic.quality).toBe("unavailable");
    expect(summary.providers.workersAi.quality).toBe("unavailable");
    expect(summary.providers.anthropic.models).toEqual([]);
  });

  it("fails closed when a summary aggregate is missing either required provider row", async () => {
    for (const result of [{ rows: [] }, { rows: [{ provider: "anthropic", model_id: null, monthly_allowance_micro_usd: null }] }, {}]) {
      await expect(getUsageSummary(binding, ACCOUNT_A, "2026-08", {
        query: vi.fn().mockResolvedValue(result), environment: "testing", now: NOW,
      })).rejects.toThrow("invalid_stored_usage");
    }
  });

  it("fails closed on malformed model aggregate rows instead of accepting exact zero usage", async () => {
    const malformedRows = [
      (() => { const row = summaryModelRow("anthropic"); delete row.uncached_input_tokens; return row; })(),
      summaryModelRow("anthropic", { output_tokens: null }),
      summaryModelRow("anthropic", { total_tokens: "not-an-integer" }),
      (() => { const row = summaryModelRow("anthropic"); delete row.consumed_micro_usd; return row; })(),
    ];
    for (const malformed of malformedRows) {
      await expect(getUsageSummary(binding, ACCOUNT_A, "2026-08", {
        query: vi.fn().mockResolvedValue({ rows: [malformed, summaryModelRow("workers_ai")] }),
        environment: "testing",
        now: NOW,
      })).rejects.toThrow("invalid_stored_usage");
    }
  });

  it("returns an account allowance override even when that provider has no usage", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      provider: "anthropic",
      model_id: null,
      monthly_allowance_micro_usd: "3000000",
      usage_quality: null,
      uncached_input_tokens: "0",
      cache_write_tokens: "0",
      cache_write_5m_tokens: "0",
      cache_write_1h_tokens: "0",
      cache_read_tokens: "0",
      output_tokens: "0",
      thinking_tokens: "0",
      prompt_tokens: "0",
      completion_tokens: "0",
      total_tokens: "0",
      estimated_neurons: "0",
      consumed_micro_usd: "0",
    }, {
      provider: "workers_ai",
      model_id: null,
      monthly_allowance_micro_usd: null,
    }] });

    const summary = await getUsageSummary(binding, ACCOUNT_A, "2026-08", {
      query,
      environment: "testing",
      now: NOW,
    });

    expect(summary.providers.anthropic).toMatchObject({
      allowanceMicroUsd: 3_000_000,
      consumedMicroUsd: 0,
      remainingMicroUsd: 3_000_000,
      quality: "unavailable",
      models: [],
    });
  });

  it("rate limits an authenticated usage read and queries only that opaque account", async () => {
    const bindings = env();
    const query = vi.fn().mockResolvedValue({ rows: [
      { provider: "anthropic", model_id: null, monthly_allowance_micro_usd: null },
      { provider: "workers_ai", model_id: null, monthly_allowance_micro_usd: null },
    ] });
    const request = new Request(`${TESTING_ORIGIN}/api/usage?month=2026-08`);
    const response = await handleUsageRequest(request, bindings, new URL(request.url), {
      accountId: ACCOUNT_A,
      environment: "testing",
    }, { query, now: NOW });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(bindings.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: `usage:${ACCOUNT_A}` });
    expect(query.mock.calls[0][2][0]).toBe(ACCOUNT_A);
    expect(JSON.stringify(query.mock.calls)).not.toContain(ACCOUNT_B);
  });

  it("rejects future and stale months before a database query", async () => {
    for (const month of ["2026-09", "2025-07", "not-a-month"]) {
      const query = vi.fn();
      const request = new Request(`${TESTING_ORIGIN}/api/usage?month=${month}`);
      const response = await handleUsageRequest(request, env(), new URL(request.url), {
        accountId: ACCOUNT_A,
        environment: "testing",
      }, { query, now: NOW });
      expect(response.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("schedules exactly one retry with only the strict terminal SQL parameters", async () => {
    const retryRow = terminalRow();
    const query = vi.fn()
      .mockRejectedValueOnce(new Error("synthetic database outage"))
      .mockResolvedValueOnce({ rows: [retryRow], rowCount: 1 });
    const scheduled: Promise<unknown>[] = [];
    const executionContext = { waitUntil: vi.fn((promise: Promise<unknown>) => scheduled.push(promise)) };
    const handle = Object.freeze({ ...validAttempt });

    expect(await finishUsageAttempt(handle, succeededUsage, { query, now: NOW, executionContext })).toBe("pending");
    expect(executionContext.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(scheduled);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][2]).toEqual([
      ACCOUNT_A, REQUEST_ID, ATTEMPT_ID, "succeeded", "exact", 100, 30, 10, 20, 30, 50, 5,
      null, null, null, null, 2_000, "2026-08-09-v1", null, "published-model", NOW.toISOString(),
    ]);
  });

  it("cleans only the active environment after 365 days and leaves allowances untouched", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 3, rows: [] });
    const deleted = await cleanupExpiredUsageAttempts(env(), { query, now: NOW });

    expect(deleted).toBe(3);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toMatch(/DELETE FROM dialogmint_ai_usage_attempts[\s\S]+environment = \$1[\s\S]+started_at < \$2/iu);
    expect(query.mock.calls[0][1]).not.toContain("dialogmint_ai_allowances");
    expect(query.mock.calls[0][2]).toEqual(["testing", "2025-08-09T12:00:00.000Z"]);
  });
});
