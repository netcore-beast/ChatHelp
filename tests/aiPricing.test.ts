import { describe, expect, it } from "vitest";
import {
  calculateEstimatedCostMicroUsd,
  estimateTokensV1,
  normalizeAnthropicUsage,
  normalizeWorkersAiUsage,
} from "../cloudflare/worker/src/aiPricing";

describe("AI usage pricing", () => {
  it("prices Opus cache classes and does not bill thinking twice", () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 1_000_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 1_000_000,
        ephemeral_1h_input_tokens: 1_000_000,
      },
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      output_tokens_details: { thinking_tokens: 400_000 },
    });

    expect(usage.thinkingTokens).toBe(400_000);
    expect(usage.outputTokens).toBe(1_000_000);
    expect(usage.estimatedCostMicroUsd).toBe(46_750_000);
  });

  it("uses exact Workers AI usage and published GPT-OSS pricing", () => {
    const usage = normalizeWorkersAiUsage({
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }, {
      modelId: "@cf/openai/gpt-oss-120b",
      normalizedInputText: "ignored",
      normalizedOutputText: "ignored",
    });

    expect(usage).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      quality: "exact",
      pricingSource: "published-model",
      estimatedCostMicroUsd: 1_100_000,
    });
  });

  it("labels the legacy Llama price as an estimated published proxy", () => {
    const usage = normalizeWorkersAiUsage({}, {
      modelId: "@cf/meta/llama-3.1-8b-instruct-fast",
      normalizedInputText: "abcd",
      normalizedOutputText: "efgh",
    });

    expect(usage.quality).toBe("estimated");
    expect(usage.pricingSource).toBe("published-proxy");
    expect(usage.estimatorVersion).toBe("characters-over-four-v1");
    expect(usage.inputTokens).toBe(1);
    expect(usage.outputTokens).toBe(1);
  });

  it("estimates normalized text with a minimum of zero tokens", () => {
    expect(estimateTokensV1("\u212B")).toBe(1);
    expect(estimateTokensV1("")).toBe(0);
    expect(estimateTokensV1(undefined)).toBe(0);
  });

  it("uses explicit integer rounding for fractional micro-USD costs", () => {
    expect(calculateEstimatedCostMicroUsd({ inputTokens: 1, outputTokens: 1 }, "workers_ai", "@cf/meta/llama-3.1-8b-instruct-fast"))
      .toBe(2);
  });

  it("rejects malformed, negative, fractional, and unbounded provider token counts", () => {
    for (const input_tokens of [-1, 1.5, Number.NaN, 100_000_001]) {
      expect(() => normalizeAnthropicUsage({ input_tokens, output_tokens: 0 })).toThrow("invalid_usage");
    }
  });

  it("uses any available exact Workers field but labels mixed usage estimated", () => {
    const usage = normalizeWorkersAiUsage({ usage: { input_tokens: 8 } }, {
      modelId: "@cf/openai/gpt-oss-120b",
      normalizedInputText: "not used",
      normalizedOutputText: "abcd",
    });

    expect(usage).toMatchObject({ inputTokens: 8, outputTokens: 1, quality: "estimated" });
    expect(usage.estimatorVersion).toBe("characters-over-four-v1");
  });
});
