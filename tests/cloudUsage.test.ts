import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMicroUsd, parseCloudUsageSummary, readCloudUsage } from "../src/lib/cloudUsage";

const totals = {
  uncachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedNeurons: 0,
};

function provider(provider: "anthropic" | "workers_ai") {
  return {
    provider,
    consumedMicroUsd: 1_234_567,
    allowanceMicroUsd: 2_000_000,
    remainingMicroUsd: 765_433,
    quality: "exact" as const,
    totals,
    models: [{ modelId: provider === "anthropic" ? "claude-opus-4-6" : "@cf/openai/gpt-oss-120b", consumedMicroUsd: 1_234_567, quality: "exact" as const, totals }],
  };
}

function summary() {
  return {
    periodStart: "2026-08-01T00:00:00.000Z",
    nextResetAt: "2026-09-01T00:00:00.000Z",
    providers: { anthropic: provider("anthropic"), workersAi: provider("workers_ai") },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("server-authoritative cloud usage client", () => {
  it("formats integer micro-USD without implying a provider balance", () => {
    expect(formatMicroUsd(1_234_567)).toBe("$1.23");
    expect(() => formatMicroUsd(-1)).toThrow(/invalid/i);
  });

  it("fetches only signed-in account usage with no-store", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(summary()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readCloudUsage("2026-08")).resolves.toEqual(summary());
    expect(fetchMock).toHaveBeenCalledWith("/api/usage?month=2026-08", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  });

  it("rejects hidden fields, unsafe integers, inconsistent provider labels, and invalid reset periods", () => {
    expect(() => parseCloudUsageSummary({ ...summary(), extra: true })).toThrow(/invalid/i);
    expect(() => parseCloudUsageSummary({
      ...summary(),
      providers: { ...summary().providers, workersAi: provider("anthropic") },
    })).toThrow(/invalid/i);
    expect(() => parseCloudUsageSummary({
      ...summary(),
      providers: { ...summary().providers, anthropic: { ...provider("anthropic"), consumedMicroUsd: Number.MAX_SAFE_INTEGER + 1 } },
    })).toThrow(/invalid/i);
    expect(() => parseCloudUsageSummary({
      ...summary(),
      providers: {
        ...summary().providers,
        anthropic: { ...provider("anthropic"), quality: "exact", models: [{ ...provider("anthropic").models[0], quality: "unavailable" }] },
      },
    })).toThrow(/invalid/i);
    expect(() => parseCloudUsageSummary({ ...summary(), nextResetAt: "2026-09-02T00:00:00.000Z" })).toThrow(/invalid/i);
  });
});
