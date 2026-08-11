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
type TestSqlQuery = (sql: string, values?: unknown[]) => Promise<unknown>;
type TestTransactionOperation = (query: TestSqlQuery) => Promise<unknown>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

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
      if (/^\s*SELECT pg_advisory_xact_lock/u.test(sql)) return { rows: [{}] };
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
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed without inserting a started attempt when the allowance aggregate is missing or malformed", async () => {
    for (const result of [{ rows: [] }, { rows: [{ monthly_allowance_micro_usd: null }] }]) {
      const query = vi.fn().mockResolvedValue(result);
      await expect(beginUsageAttempt(validAttempt, { query, now: NOW })).rejects.toThrow("usage_allowance_unavailable");
      expect(query).toHaveBeenCalledTimes(2);
    }
  });

  it("fails closed when the locked allowance admission sees an in-flight attempt", async () => {
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
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toMatch(/pg_advisory_xact_lock/u);
    expect(query.mock.calls[1][1]).not.toMatch(/pg_advisory_xact_lock/u);
  });

  it("self-heals a stale same-scope attempt after acquiring the transaction lock", async () => {
    const staleAttempt = {
      accountId: ACCOUNT_A,
      provider: "anthropic",
      environment: "testing",
      status: "started",
      startedAt: "2026-08-09T11:49:59.999Z",
      completedAt: null as string | null,
    };
    let lockHeld = false;
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => operation(
      async (sql: string, values: unknown[] = []) => {
        commands.push({ sql, values });
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) {
          lockHeld = true;
          return { rows: [{ locked: true }] };
        }
        const cutoff = values[13];
        const completedAt = values[14];
        const hasLeaseReap = /stale_attempts\s+AS\s*\([\s\S]*?UPDATE dialogmint_ai_usage_attempts[\s\S]*?SET status = 'cancelled',[\s\S]*?completed_at = \$15[\s\S]*?account_id = \$1[\s\S]*?provider = \$2[\s\S]*?environment = \$3[\s\S]*?status = 'started'[\s\S]*?started_at < \$14[\s\S]*?RETURNING 1/iu.test(sql);
        if (lockHeld && hasLeaseReap
            && staleAttempt.accountId === values[0]
            && staleAttempt.provider === values[1]
            && staleAttempt.environment === values[2]
            && staleAttempt.startedAt < String(cutoff)) {
          staleAttempt.status = "cancelled";
          staleAttempt.completedAt = String(completedAt);
        }
        const freshStarted = staleAttempt.status === "started" && staleAttempt.startedAt >= String(cutoff) ? 1 : 0;
        return { rows: [{
          monthly_allowance_micro_usd: "100",
          consumed_micro_usd: "0",
          started_attempts: String(freshStarted),
          inserted: freshStarted === 0,
        }] };
      },
    ));
    const outsideTransaction = vi.fn().mockRejectedValue(new Error("query escaped transaction"));

    await expect(beginUsageAttempt(validAttempt, {
      query: outsideTransaction,
      transaction,
      now: NOW,
    })).resolves.toMatchObject({ kind: "started" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(outsideTransaction).not.toHaveBeenCalled();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({
      sql: expect.stringMatching(/^\s*SELECT pg_advisory_xact_lock/iu),
      values: [ACCOUNT_A, "anthropic", "testing"],
    });
    expect(staleAttempt).toMatchObject({
      status: "cancelled",
      completedAt: NOW.toISOString(),
    });
  });

  it("keeps a fresh same-scope attempt blocking admission at the lease boundary", async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => operation(
      async (sql: string, values: unknown[] = []) => {
        commands.push({ sql, values });
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) return { rows: [{}] };
        return { rows: [{
          monthly_allowance_micro_usd: "100",
          consumed_micro_usd: "0",
          started_attempts: "1",
          inserted: false,
        }] };
      },
    ));

    await expect(beginUsageAttempt(validAttempt, {
      query: vi.fn().mockRejectedValue(new Error("query escaped transaction")),
      transaction,
      now: NOW,
    })).resolves.toEqual({
      kind: "allowance-unavailable",
      nextResetAt: "2026-09-01T00:00:00.000Z",
    });
    const sql = commands[1].sql;
    expect(sql.match(/count\(\*\) FILTER \([\s\S]*?\) AS started_attempts/u)?.[0]).toMatch(
      /status = 'started'[\s\S]*?environment = \$3[\s\S]*?started_at >= \$14/u,
    );
  });

  it("scopes lease cleanup to one account, provider, and environment without returning identifiers", async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => operation(
      async (sql: string, values: unknown[] = []) => {
        commands.push({ sql, values });
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) return { rows: [{}] };
        return { rows: [{
          monthly_allowance_micro_usd: "100",
          consumed_micro_usd: "0",
          started_attempts: "0",
          inserted: true,
        }] };
      },
    ));

    await beginUsageAttempt(validAttempt, {
      query: vi.fn().mockRejectedValue(new Error("query escaped transaction")),
      transaction,
      now: NOW,
    });
    const sql = commands[1].sql;
    const staleUpdate = sql.match(/stale_attempts\s+AS\s*\(([\s\S]*?)\),\s*allowance_state/iu)?.[1] ?? "";
    expect(staleUpdate).toMatch(/account_id = \$1/u);
    expect(staleUpdate).toMatch(/provider = \$2/u);
    expect(staleUpdate).toMatch(/environment = \$3/u);
    expect(staleUpdate).toMatch(/status = 'started'/u);
    expect(staleUpdate).toMatch(/RETURNING 1\s*$/u);
    expect(staleUpdate).not.toMatch(/RETURNING\s+(?:\*|account_id|request_id|attempt_id)/iu);
    expect(staleUpdate).not.toMatch(/usage_quality\s*=/iu);
  });

  it("parameterizes the ten-minute lease cutoff and cancellation completion time", async () => {
    const commands: Array<{ sql: string; values: unknown[] }> = [];
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => operation(
      async (sql: string, values: unknown[] = []) => {
        commands.push({ sql, values });
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) return { rows: [{}] };
        return { rows: [{
          monthly_allowance_micro_usd: "100",
          consumed_micro_usd: "0",
          started_attempts: "0",
          inserted: true,
        }] };
      },
    ));

    await beginUsageAttempt(validAttempt, {
      query: vi.fn().mockRejectedValue(new Error("query escaped transaction")),
      transaction,
      now: NOW,
    });
    const { sql, values } = commands[1];
    expect(values.slice(13)).toEqual([
      "2026-08-09T11:50:00.000Z",
      "2026-08-09T12:00:00.000Z",
    ]);
    expect(sql).toContain("started_at < $14");
    expect(sql).toContain("completed_at = $15");
    expect(sql).not.toContain("2026-08-09T11:50:00.000Z");
    expect(sql).not.toContain("2026-08-09T12:00:00.000Z");
  });

  it("serializes two interleaved same-scope admissions on separate transaction clients", async () => {
    const stored: Array<{ accountId: string; provider: string; environment: string; startedAt: string }> = [];
    let nextLock = Promise.resolve();
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => {
      let releaseLock: (() => void) | undefined;
      let holdsLock = false;
      try {
        return await operation(async (sql: string, values: unknown[] = []) => {
          if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) {
            const previousLock = nextLock;
            nextLock = new Promise<void>((resolve) => { releaseLock = resolve; });
            await previousLock;
            holdsLock = true;
            return { rows: [{}] };
          }
          if (!holdsLock) throw new Error("admission ran before its transaction lock");
          const cutoff = String(values[13]);
          const fresh = stored.filter((row) => row.accountId === values[0]
            && row.provider === values[1] && row.environment === values[2]
            && row.startedAt >= cutoff);
          const inserted = fresh.length === 0;
          if (inserted) {
            stored.push({
              accountId: String(values[0]),
              provider: String(values[1]),
              environment: String(values[2]),
              startedAt: String(values[9]),
            });
          }
          return { rows: [{
            monthly_allowance_micro_usd: "100",
            consumed_micro_usd: "0",
            started_attempts: String(fresh.length),
            inserted,
          }] };
        });
      } finally {
        if (holdsLock) releaseLock?.();
      }
    });
    const secondAttempt = {
      ...validAttempt,
      requestId: "33333333-3333-4333-8333-333333333333",
      attemptId: "44444444-4444-4444-8444-444444444444",
    };

    const results = await Promise.all([
      beginUsageAttempt(validAttempt, {
        query: vi.fn().mockRejectedValue(new Error("query escaped transaction")), transaction, now: NOW,
      }),
      beginUsageAttempt(secondAttempt, {
        query: vi.fn().mockRejectedValue(new Error("query escaped transaction")), transaction, now: NOW,
      }),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual(["allowance-unavailable", "started"]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(stored).toHaveLength(1);
  });

  it("keeps an identical fresh attempt replay single-row and unavailable", async () => {
    const commands: string[] = [];
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => operation(
      async (sql: string) => {
        commands.push(sql);
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) return { rows: [{}] };
        return { rows: [{
          monthly_allowance_micro_usd: "100",
          consumed_micro_usd: "0",
          started_attempts: "1",
          inserted: false,
        }] };
      },
    ));

    await expect(beginUsageAttempt(validAttempt, {
      query: vi.fn().mockRejectedValue(new Error("query escaped transaction")),
      transaction,
      now: NOW,
    })).resolves.toEqual({
      kind: "allowance-unavailable",
      nextResetAt: "2026-09-01T00:00:00.000Z",
    });

    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatch(/ON CONFLICT \(account_id, request_id, attempt_id\) DO NOTHING/u);
  });

  it("recovers a stale attempt across a billing-month boundary by lease age", async () => {
    const now = new Date("2026-09-01T00:05:00.000Z");
    const septemberAttempt = {
      ...validAttempt,
      attemptId: "33333333-3333-4333-8333-333333333333",
      startedAt: now.toISOString(),
    };
    const priorMonthAttempt = {
      status: "started",
      startedAt: "2026-08-31T23:54:59.999Z",
      completedAt: null as string | null,
    };
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => operation(
      async (sql: string, values: unknown[] = []) => {
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) return { rows: [{}] };
        const cutoff = String(values[13]);
        if (/started_at < \$14/u.test(sql) && priorMonthAttempt.startedAt < cutoff) {
          priorMonthAttempt.status = "cancelled";
          priorMonthAttempt.completedAt = String(values[14]);
        }
        const freshStarted = priorMonthAttempt.status === "started" && priorMonthAttempt.startedAt >= cutoff ? 1 : 0;
        return { rows: [{
          monthly_allowance_micro_usd: "100",
          consumed_micro_usd: "0",
          started_attempts: String(freshStarted),
          inserted: freshStarted === 0,
        }] };
      },
    ));

    await expect(beginUsageAttempt(septemberAttempt, {
      query: vi.fn().mockRejectedValue(new Error("query escaped transaction")),
      transaction,
      now,
    })).resolves.toMatchObject({ kind: "started" });
    expect(priorMonthAttempt).toEqual({
      status: "cancelled",
      startedAt: "2026-08-31T23:54:59.999Z",
      completedAt: "2026-09-01T00:05:00.000Z",
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

  it("does not let a late terminal write overwrite a lease-cancelled attempt", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      ...terminalRow(),
      status: "cancelled",
      usage_quality: "unavailable",
      completed_at: NOW.toISOString(),
    }] });

    await expect(finishUsageAttempt(Object.freeze({ ...validAttempt }), succeededUsage, {
      query,
      now: NOW,
    })).rejects.toThrow("usage_terminal_conflict");
    const [, sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/terminal_lock\s+AS\s*\([\s\S]*?pg_advisory_xact_lock/iu);
    expect(sql).toMatch(/UPDATE dialogmint_ai_usage_attempts[\s\S]*?FROM terminal_lock[\s\S]*?account_id = \$1[\s\S]*?provider = \$22[\s\S]*?environment = \$23[\s\S]*?status = 'started'/u);
    expect(sql).toMatch(/SELECT \* FROM dialogmint_ai_usage_attempts[\s\S]*?provider = \$22[\s\S]*?environment = \$23/u);
    expect(values.slice(21)).toEqual(["anthropic", "testing"]);
    expect(JSON.stringify(values)).not.toContain("SYNTHETIC_PROVIDER_BODY");
  });

  it("makes a terminal-first completion visible before stale admission calculates allowance", async () => {
    const staleHandle = Object.freeze({
      ...validAttempt,
      startedAt: "2026-08-09T11:49:59.999Z",
    });
    const nextAttempt = {
      ...validAttempt,
      requestId: "33333333-3333-4333-8333-333333333333",
      attemptId: "44444444-4444-4444-8444-444444444444",
    };
    const terminalStarted = deferred();
    const releaseTerminal = deferred();
    const terminalCommitted = deferred();
    const admissionReady = deferred();
    let terminalHasScopeLock = false;
    let storedStatus = "started";
    let storedCost = 0;
    const terminalQuery = vi.fn(async (_binding: unknown, sql: string) => {
      terminalHasScopeLock = /terminal_lock\s+AS[\s\S]*?pg_advisory_xact_lock/iu.test(sql)
        && /UPDATE dialogmint_ai_usage_attempts[\s\S]*?FROM terminal_lock/iu.test(sql);
      terminalStarted.resolve();
      await releaseTerminal.promise;
      storedStatus = "succeeded";
      storedCost = succeededUsage.usage.estimatedCostMicroUsd;
      terminalCommitted.resolve();
      return { rows: [terminalRow()], rowCount: 1 };
    });
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => operation(
      async (sql: string) => {
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) {
          if (terminalHasScopeLock) {
            admissionReady.resolve();
            await terminalCommitted.promise;
          }
          return { rows: [{}] };
        }
        const snapshot = { status: storedStatus, cost: storedCost };
        if (!terminalHasScopeLock) {
          admissionReady.resolve();
          await terminalCommitted.promise;
        }
        const visible = terminalHasScopeLock ? { status: storedStatus, cost: storedCost } : snapshot;
        const consumed = visible.status === "started" ? 0 : visible.cost;
        return { rows: [{
          monthly_allowance_micro_usd: String(succeededUsage.usage.estimatedCostMicroUsd),
          consumed_micro_usd: String(consumed),
          started_attempts: "0",
          inserted: consumed < succeededUsage.usage.estimatedCostMicroUsd,
        }] };
      },
    ));

    const terminal = finishUsageAttempt(staleHandle, succeededUsage, { query: terminalQuery, now: NOW });
    await terminalStarted.promise;
    const admission = beginUsageAttempt(nextAttempt, {
      query: vi.fn().mockRejectedValue(new Error("query escaped transaction")),
      transaction,
      now: NOW,
    });
    await admissionReady.promise;
    releaseTerminal.resolve();

    await expect(terminal).resolves.toBe("recorded");
    await expect(admission).resolves.toEqual({
      kind: "allowance-exhausted",
      nextResetAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("makes an admission-first lease cancellation win before a terminal update", async () => {
    const staleHandle = Object.freeze({
      ...validAttempt,
      startedAt: "2026-08-09T11:49:59.999Z",
    });
    const nextAttempt = {
      ...validAttempt,
      requestId: "33333333-3333-4333-8333-333333333333",
      attemptId: "44444444-4444-4444-8444-444444444444",
    };
    const admissionUpdated = deferred();
    const releaseAdmission = deferred();
    const admissionCommitted = deferred();
    const terminalReady = deferred();
    let admissionHasScopeLock = false;
    let terminalSettled = false;
    const transaction = vi.fn(async (_binding: unknown, operation: TestTransactionOperation) => {
      const result = await operation(async (sql: string) => {
        if (/^\s*SELECT pg_advisory_xact_lock/iu.test(sql)) {
          admissionHasScopeLock = true;
          return { rows: [{}] };
        }
        admissionUpdated.resolve();
        return { rows: [{
          monthly_allowance_micro_usd: "100",
          consumed_micro_usd: "0",
          started_attempts: "0",
          inserted: true,
        }] };
      });
      await releaseAdmission.promise;
      admissionHasScopeLock = false;
      admissionCommitted.resolve();
      return result;
    });
    const terminalQuery = vi.fn(async (_binding: unknown, sql: string) => {
      const terminalHasScopeLock = /terminal_lock\s+AS[\s\S]*?pg_advisory_xact_lock/iu.test(sql)
        && /UPDATE dialogmint_ai_usage_attempts[\s\S]*?FROM terminal_lock/iu.test(sql);
      terminalReady.resolve();
      if (terminalHasScopeLock && admissionHasScopeLock) await admissionCommitted.promise;
      return { rows: [{
        ...terminalRow(),
        status: "cancelled",
        usage_quality: "unavailable",
      }], rowCount: 1 };
    });

    const admission = beginUsageAttempt(nextAttempt, {
      query: vi.fn().mockRejectedValue(new Error("query escaped transaction")),
      transaction,
      now: NOW,
    });
    await admissionUpdated.promise;
    const terminal = finishUsageAttempt(staleHandle, succeededUsage, {
      query: terminalQuery,
      now: NOW,
    }).then(
      (result) => { terminalSettled = true; return result; },
      (error) => { terminalSettled = true; throw error; },
    );
    await terminalReady.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    releaseAdmission.resolve();

    await expect(admission).resolves.toMatchObject({ kind: "started" });
    await expect(terminal).rejects.toThrow("usage_terminal_conflict");
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
      "anthropic", "testing",
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
