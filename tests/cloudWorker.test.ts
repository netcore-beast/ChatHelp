import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_MODEL,
  GPT_REVIEW_MODEL,
  LLAMA_CANDIDATE_MODEL,
  WORKERS_AI_MODEL,
  handleRequest,
} from "../cloudflare/worker/src/index.js";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const TESTING_ORIGIN = `https://${TESTING_HOST}`;
const PRODUCTION_HOST = "chathelp-private-cloud.project-mission-ai.workers.dev";
const SYNTHETIC_ASSERTION = "synthetic.assertion.value";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const NEXT_RESET_AT = "2026-09-01T00:00:00.000Z";

const ANALYSIS = {
  observedStage: "identify_need",
  latestIncomingIntent: "The contact wants role details.",
  knownFacts: ["The contact asked for role details."],
  unansweredQuestions: ["Which detail matters most?"],
  goalForThisReply: "Answer briefly and clarify the priority.",
  toneDirectives: ["Warm", "Concise"],
  prohibitedMoves: ["Do not pitch"],
  replyPlan: "Answer briefly, then ask one focused question.",
  evidence: ["m1"],
  needEstablished: false,
  permissionGranted: false,
  explicitRequest: false,
};

const CANDIDATE = {
  draft: {
    text: "I can share the key details. Which part would be most useful to start with?",
  },
};

const REVIEW = {
  scores: {
    conversationGrounding: 25,
    latestMessageRelevance: 20,
    personalGuidelineCompliance: 15,
    goalStageAlignment: 15,
    humanTone: 10,
    curiosityNeedDiscovery: 5,
    technicalFactualAccuracy: 5,
    ethicalSellingBoundaries: 5,
  },
  criticalFailures: [],
  finalDraft: CANDIDATE.draft.text,
};

function structuredPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversationContext: "<conversation_context>\n{\"recentMessages\":[{\"id\":\"m1\",\"sender\":\"CONTACT\",\"text\":\"Could you share the role details?\"}]}\n</conversation_context>",
    latestActualMessage: { id: "m1", sender: "CONTACT", speaker: "Alex", text: "Could you share the role details?", timestamp: "2026-01-01T00:00:00.000Z" },
    latestMeaningfulIncoming: { id: "m1", sender: "CONTACT", speaker: "Alex", text: "Could you share the role details?", timestamp: "2026-01-01T00:00:00.000Z" },
    playbook: {
      role: "Human Resource",
      relationshipGoal: "Build trust before discussing a role",
      voice: "Warm and concise",
      rulebookFull: "Never pressure the contact.",
      rulebookDigest: "No pressure.",
    },
    personalGuidelines: "Use plain language and one useful question.",
    conversationGoal: "Learn which role detail matters most.",
    relationshipStage: "learn_interests",
    knownFacts: ["The contact asked for role details."],
    unansweredQuestions: ["Which detail matters most?"],
    replyObjective: "Answer directly, then clarify their priority.",
    ...overrides,
  };
}

function anthropicResponse(value: unknown) {
  return new Response(JSON.stringify({
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    content: [{ type: "text", text: JSON.stringify(value) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function workerEnv(options: { anthropicConfigured?: boolean } = {}) {
  const fallbackResponses = [ANALYSIS, CANDIDATE, REVIEW];
  return {
    DEPLOYMENT_ENVIRONMENT: "testing",
    ...(options.anthropicConfigured === false ? {} : { ANTHROPIC_API_KEY: "[runtime-secret]" }),
    ACCESS_TEAM_DOMAIN: "https://dialogmint.cloudflareaccess.com",
    ACCESS_AUD_TESTING: "testing-audience",
    ACCESS_AUD_PRODUCTION: "production-audience",
    NEON_TESTING: { connectionString: "synthetic-testing-binding" },
    NEON_PRODUCTION: { connectionString: "synthetic-production-binding" },
    DRAFT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    AI: { run: vi.fn(async () => ({ response: fallbackResponses.shift() })) },
  };
}

function createUsageRecorder(accounting: Array<"recorded" | "pending"> = []) {
  let attempt = 0;
  return {
    begin: vi.fn<(input: unknown) => Promise<unknown>>().mockImplementation(async () => ({ kind: "started", handle: { attemptId: `attempt-${++attempt}` } })),
    finish: vi.fn<(handle: unknown, terminal: unknown) => Promise<"recorded" | "pending">>().mockImplementation(async () => accounting.shift() ?? "recorded"),
  };
}

function draftOptions(overrides: Record<string, unknown> = {}) {
  return {
    verifyAccess,
    usageRecorder: createUsageRecorder(),
    randomUUID: vi.fn(() => REQUEST_ID),
    ...overrides,
  };
}

function expectedDraftResult(provider: "anthropic" | "cloudflare", overrides: Record<string, unknown> = {}) {
  return {
    draft: REVIEW.finalDraft,
    provider,
    model: provider === "anthropic" ? ANTHROPIC_MODEL : WORKERS_AI_MODEL,
    mode: "stage-aware-single-draft-v1",
    requestId: REQUEST_ID,
    usageAccounting: "recorded",
    fallbackReason: provider === "anthropic" ? null : "anthropic-pipeline-failed",
    ...overrides,
  };
}

const verifyAccess = vi.fn(async (_assertion: string, options: { issuer: string; audience: string }) => ({
  payload: { iss: options.issuer, aud: [options.audience], sub: "synthetic-subject", exp: 2_000_000_000 },
}));

function expectedHealth(deploymentEnvironment: "testing" | "production", configured: boolean) {
  return {
    ok: true,
    service: "dialogmint-cloud",
    deploymentEnvironment,
    primaryProvider: "anthropic",
    primaryModel: ANTHROPIC_MODEL,
    fallbackModels: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
    learning: { configured, schemaVersion: 1, retentionDays: 365 },
    usage: {
      configured,
      pricingVersion: "2026-08-09-v1",
      estimatorVersion: "characters-over-four-v1",
      retentionDays: 365,
    },
    recovery: { configured, encrypted: true, retentionDays: 90 },
  };
}

function draftRequest(body: unknown, origin = TESTING_ORIGIN, stream = false) {
  return new Request(`${TESTING_ORIGIN}/api/drafts`, {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": SYNTHETIC_ASSERTION,
      "Content-Type": "application/json",
      Origin: origin,
      ...(stream ? { Accept: "text/event-stream, application/json" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function parseSseEvents(text: string) {
  return text.trim().split(/\n\n+/).map((frame) => {
    const lines = frame.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event:"))?.slice(6).trim(),
      data: JSON.parse(lines.find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "null"),
    };
  });
}

describe("Cloudflare private inference Worker", () => {
  it.each([
    ["testing", TESTING_HOST],
    ["production", PRODUCTION_HOST],
  ] as const)("reports only safe health metadata for the active %s environment", async (deploymentEnvironment, hostname) => {
    const env = { ...workerEnv(), DEPLOYMENT_ENVIRONMENT: deploymentEnvironment };
    const response = await handleRequest(new Request(`https://${hostname}/health`), env, { verifyAccess });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedHealth(deploymentEnvironment, true));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports health storage as unconfigured when only the inactive environment binding exists", async () => {
    const env = { ...workerEnv(), NEON_TESTING: undefined };

    const response = await handleRequest(new Request(`${TESTING_ORIGIN}/health`), env, { verifyAccess });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedHealth("testing", false));
  });

  it("uses Claude successfully without invoking either fallback model", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
    const env = workerEnv();
    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({ anthropicFetch }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("anthropic"));
    expect(anthropicFetch).toHaveBeenCalledTimes(3);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("retrieves at most three current-account examples inside the authenticated worker", async () => {
    const rows = [
      { role_id: "human_resource", relationship_stage: "learn_interests", goal_category: "discover_interests", target_text: "Approved first example" },
      { role_id: "human_resource", relationship_stage: "identify_need", goal_category: "identify_need", target_text: "Approved second example" },
      { role_id: "network_marketing", relationship_stage: "genuine_rapport", goal_category: "build_rapport", target_text: "Approved third example" },
      { role_id: "job_seeker", relationship_stage: "new_connection", goal_category: "connect", target_text: "FOURTH EXAMPLE MUST NOT REACH A PROVIDER" },
    ];
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ enabled: true }] })
      .mockResolvedValueOnce({ rows });
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));

    const response = await handleRequest(draftRequest(structuredPayload()), workerEnv(), draftOptions({ anthropicFetch, query }));

    expect(response.status).toBe(200);
    const accountId = query.mock.calls[0][2][0];
    expect(accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(query.mock.calls[1][2]).toEqual([
      accountId,
      expect.any(String),
      "learn_interests",
      "human_resource",
      "discover_interests",
    ]);
    const providerBodies = anthropicFetch.mock.calls.map(([, init]) => String(init?.body));
    for (const body of providerBodies) {
      expect(body).toContain("Approved first example");
      expect(body).toContain("Approved second example");
      expect(body).toContain("Approved third example");
      expect(body).not.toContain("FOURTH EXAMPLE MUST NOT REACH A PROVIDER");
    }
  });

  it("fails open to zero examples when learning retrieval is unavailable", async () => {
    const query = vi.fn().mockRejectedValue(new Error("synthetic database outage"));
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));

    const response = await handleRequest(draftRequest(structuredPayload()), workerEnv(), draftOptions({ anthropicFetch, query }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ provider: "anthropic", model: ANTHROPIC_MODEL });
    expect(query).toHaveBeenCalledTimes(1);
    for (const [, init] of anthropicFetch.mock.calls) {
      expect(String(init?.body)).toContain("No approved personal examples are available.");
    }
  });

  it("rejects browser-supplied learning material before retrieval or inference", async () => {
    const env = workerEnv();
    const query = vi.fn();
    const anthropicFetch = vi.fn();
    const response = await handleRequest(draftRequest(structuredPayload({
      feedbackSummary: "Browser-stored feedback",
      learningExamples: [{ preferredResponse: "Browser-stored example" }],
    })), env, { verifyAccess, anthropicFetch, query });

    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(anthropicFetch).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it.each([
    ["missing configuration", null, false],
    ["network failure", "network", true],
    ["timeout", "timeout", true],
    ["rate limit", 429, true],
    ["provider server failure", 529, true],
  ])("uses the permanent fallback for %s", async (_name, failure, configured) => {
    const env = workerEnv({ anthropicConfigured: configured });
    const anthropicFetch = failure === "network"
      ? vi.fn(async () => { throw new TypeError("synthetic network failure"); })
      : failure === "timeout"
        ? vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          }))
        : typeof failure === "number"
          ? vi.fn(async () => new Response("synthetic provider detail", { status: failure }))
          : vi.fn();
    const response = await handleRequest(draftRequest(structuredPayload()), env, {
      ...draftOptions(),
      anthropicFetch,
      anthropicTimeoutMs: 1,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("cloudflare"));
    expect(env.AI.run).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 400])("uses the permanent fallback for Anthropic HTTP %s", async (status) => {
    const env = workerEnv();
    const anthropicFetch = vi.fn(async () => new Response("synthetic provider detail", { status }));
    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({ anthropicFetch }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("cloudflare"));
    expect(env.AI.run).toHaveBeenCalledTimes(3);
  });

  it("regenerates the permanent fallback once when its first review misses the quality threshold", async () => {
    const lowReview = {
      ...REVIEW,
      scores: { ...REVIEW.scores, conversationGrounding: 14 },
    };
    const fallbackResponses = [ANALYSIS, CANDIDATE, lowReview, ANALYSIS, CANDIDATE, REVIEW];
    const env = workerEnv({ anthropicConfigured: false });
    env.AI.run = vi.fn(async () => ({ response: fallbackResponses.shift() }));
    const usageRecorder = createUsageRecorder(["recorded", "recorded", "pending", "recorded", "recorded", "recorded"]);

    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({ usageRecorder }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      draft: REVIEW.finalDraft,
      provider: "cloudflare",
      model: WORKERS_AI_MODEL,
      requestId: REQUEST_ID,
      usageAccounting: "pending",
      fallbackReason: "anthropic-pipeline-failed",
    });
    expect(env.AI.run).toHaveBeenCalledTimes(6);
    expect(usageRecorder.begin).toHaveBeenCalledTimes(6);
    expect(usageRecorder.finish).toHaveBeenCalledTimes(6);
  });

  it("preserves a pending structured Workers call across failed plain JSON and full retry", async () => {
    const env = workerEnv({ anthropicConfigured: false });
    env.AI.run = vi.fn()
      .mockRejectedValueOnce(new Error("SYNTHETIC_JSON_MODE_DETAIL"))
      .mockResolvedValueOnce({ response: "not-json" })
      .mockResolvedValueOnce({ response: ANALYSIS })
      .mockResolvedValueOnce({ response: CANDIDATE })
      .mockResolvedValueOnce({ response: REVIEW });
    const usageRecorder = createUsageRecorder(["pending", "recorded", "recorded", "recorded", "recorded"]);

    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({ usageRecorder }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("cloudflare", {
      usageAccounting: "pending",
    }));
    expect(env.AI.run).toHaveBeenCalledTimes(5);
    expect(usageRecorder.begin).toHaveBeenCalledTimes(5);
    expect(usageRecorder.finish).toHaveBeenCalledTimes(5);
  });

  it("uses the permanent fallback when Claude returns invalid quality or a critical policy failure", async () => {
    for (const responses of [
      [{ invalid: "analysis" }],
      [ANALYSIS, CANDIDATE, { ...REVIEW, criticalFailures: ["premature_pitch"] }],
    ]) {
      const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
      const env = workerEnv();
      const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({ anthropicFetch }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(expectedDraftResult("cloudflare"));
      expect(env.AI.run).toHaveBeenCalledTimes(3);
    }
  });

  it("skips Claude when its allowance is exhausted and reports the fallback reason", async () => {
    const env = workerEnv();
    const anthropicFetch = vi.fn();
    const usageRecorder = createUsageRecorder();
    usageRecorder.begin
      .mockResolvedValueOnce({ kind: "allowance-exhausted", nextResetAt: NEXT_RESET_AT })
      .mockImplementation(async () => ({ kind: "started", handle: { attemptId: crypto.randomUUID() } }));
    const randomUUID = vi.fn(() => REQUEST_ID);

    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({
      anthropicFetch,
      usageRecorder,
      randomUUID,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("cloudflare", {
      fallbackReason: "anthropic-allowance-exhausted",
    }));
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(anthropicFetch).not.toHaveBeenCalled();
    expect(env.AI.run).toHaveBeenCalledTimes(3);
    expect(usageRecorder.begin.mock.calls[0][0]).toEqual({
      provider: "anthropic",
      modelId: ANTHROPIC_MODEL,
      pipelineStage: "analyzing",
    });
  });

  it("calls no provider when neither provider can insert a started row", async () => {
    const env = workerEnv();
    const anthropicFetch = vi.fn();
    const usageRecorder = createUsageRecorder();
    usageRecorder.begin.mockRejectedValue(new Error("SYNTHETIC_LEDGER_DETAIL"));

    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({
      anthropicFetch,
      usageRecorder,
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cloud AI accounting is temporarily unavailable. Please try again.",
      code: "accounting_unavailable",
    });
    expect(anthropicFetch).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("reports the shared next reset when both provider allowances are exhausted", async () => {
    const env = workerEnv();
    const anthropicFetch = vi.fn();
    const usageRecorder = createUsageRecorder();
    usageRecorder.begin.mockResolvedValue({ kind: "allowance-exhausted", nextResetAt: NEXT_RESET_AT });

    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({
      anthropicFetch,
      usageRecorder,
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "The estimated monthly app allowance is exhausted. Please try again after the reset.",
      code: "allowance_exhausted",
      nextResetAt: NEXT_RESET_AT,
    });
    expect(anthropicFetch).not.toHaveBeenCalled();
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("returns a valid paid draft when terminal accounting is pending", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
    const usageRecorder = createUsageRecorder(["recorded", "pending", "recorded"]);

    const response = await handleRequest(draftRequest(structuredPayload()), workerEnv(), draftOptions({
      anthropicFetch,
      usageRecorder,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("anthropic", {
      usageAccounting: "pending",
    }));
    expect(usageRecorder.finish).toHaveBeenCalledTimes(3);
  });

  it("preserves pending accounting from a failed primary attempt when fallback succeeds", async () => {
    const env = workerEnv();
    const anthropicFetch = vi.fn(async () => new Response("SYNTHETIC_PROVIDER_BODY", { status: 500 }));
    const usageRecorder = createUsageRecorder(["pending", "recorded", "recorded", "recorded"]);

    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({
      anthropicFetch,
      usageRecorder,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("cloudflare", {
      usageAccounting: "pending",
    }));
    expect(usageRecorder.finish).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(usageRecorder.finish.mock.calls)).not.toContain("SYNTHETIC_PROVIDER_BODY");
  });

  it("fails closed when a successful Anthropic call cannot write its terminal accounting", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
    const usageRecorder = createUsageRecorder();
    usageRecorder.finish.mockRejectedValueOnce(new Error("SYNTHETIC_TERMINAL_LEDGER_DETAIL"));
    const env = workerEnv();

    const response = await handleRequest(draftRequest(structuredPayload()), env, draftOptions({
      anthropicFetch,
      usageRecorder,
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Cloud AI accounting is temporarily unavailable. Please try again.",
      code: "accounting_unavailable",
    });
    expect(anthropicFetch).toHaveBeenCalledTimes(1);
    expect(usageRecorder.finish).toHaveBeenCalledTimes(1);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("wires one authenticated request ID through the production recorder and pending retry", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
    const env = workerEnv();
    const pendingRetries: Promise<unknown>[] = [];
    const executionContext = { waitUntil: vi.fn((promise: Promise<unknown>) => pendingRetries.push(promise)) };
    let terminalUpdates = 0;
    const query = vi.fn(async (_binding: unknown, sql: string, values: unknown[] = []) => {
      if (sql.includes("dialogmint_learning_preferences")) return { rows: [{ enabled: false }] };
      if (sql.includes("monthly_allowance_micro_usd")) {
        return { rows: [{ monthly_allowance_micro_usd: 10_000_000, consumed_micro_usd: 0, started_attempts: 0, inserted: true }] };
      }
      if (sql.includes("INSERT INTO dialogmint_ai_usage_attempts")) return { rows: [{ inserted: true }], rowCount: 1 };
      if (sql.includes("WITH updated AS")) {
        terminalUpdates += 1;
        if (terminalUpdates === 1) throw new Error("SYNTHETIC_TRANSIENT_TERMINAL_OUTAGE");
        return {
          rows: [{
            account_id: values[0],
            request_id: values[1],
            attempt_id: values[2],
            status: values[3],
            usage_quality: values[4],
            uncached_input_tokens: values[5],
            cache_write_tokens: values[6],
            cache_write_5m_tokens: values[7],
            cache_write_1h_tokens: values[8],
            cache_read_tokens: values[9],
            output_tokens: values[10],
            thinking_tokens: values[11],
            prompt_tokens: values[12],
            completion_tokens: values[13],
            total_tokens: values[14],
            estimated_neurons: values[15],
            estimated_cost_micro_usd: values[16],
            pricing_version: values[17],
            estimator_version: values[18],
            pricing_source: values[19],
            completed_at: values[20],
          }],
        };
      }
      throw new Error("Unexpected synthetic query");
    });

    const response = await handleRequest(draftRequest(structuredPayload()), env, {
      verifyAccess,
      anthropicFetch,
      query,
      executionContext,
      randomUUID: vi.fn(() => REQUEST_ID),
      now: new Date("2026-08-09T12:00:00.000Z"),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expectedDraftResult("anthropic", { usageAccounting: "pending" }));
    expect(executionContext.waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pendingRetries);
    const insertCalls = query.mock.calls.filter(([, sql]) => String(sql).includes("INSERT INTO dialogmint_ai_usage_attempts"));
    expect(insertCalls).toHaveLength(3);
    const insertValues = insertCalls.map((call) => call[2] as unknown[]);
    expect(new Set(insertValues.map((values) => values[5]))).toEqual(new Set([REQUEST_ID]));
    expect(new Set(insertValues.map((values) => values[6])).size).toBe(3);
    for (const values of insertValues) {
      expect(values[0]).toMatch(/^[0-9a-f]{64}$/u);
      expect(values[6]).toMatch(/^[0-9a-f-]{36}$/u);
      expect(values[1]).toBe("anthropic");
      expect(values[2]).toBe("testing");
    }
    expect(query.mock.calls.every(([binding]) => binding === env.NEON_TESTING)).toBe(true);
  });

  it("returns exact JSON and SSE result parity for one request ID per request", async () => {
    const makeFetch = () => {
      const responses = [ANALYSIS, CANDIDATE, REVIEW];
      return vi.fn(async () => anthropicResponse(responses.shift()));
    };
    const jsonRandomUUID = vi.fn(() => REQUEST_ID);
    const streamRandomUUID = vi.fn(() => REQUEST_ID);
    const jsonResponse = await handleRequest(draftRequest(structuredPayload()), workerEnv(), draftOptions({
      anthropicFetch: makeFetch(),
      randomUUID: jsonRandomUUID,
    }));
    const streamResponse = await handleRequest(
      draftRequest(structuredPayload(), TESTING_ORIGIN, true),
      workerEnv(),
      draftOptions({ anthropicFetch: makeFetch(), randomUUID: streamRandomUUID }),
    );

    const jsonResult = await jsonResponse.json();
    const streamResult = parseSseEvents(await streamResponse.text()).at(-1)?.data;
    expect(jsonResult).toEqual(expectedDraftResult("anthropic"));
    expect(streamResult).toEqual(jsonResult);
    expect(Object.keys(jsonResult)).toEqual([
      "draft", "provider", "model", "mode", "requestId", "usageAccounting", "fallbackReason",
    ]);
    expect(jsonRandomUUID).toHaveBeenCalledTimes(1);
    expect(streamRandomUUID).toHaveBeenCalledTimes(1);
  });

  it("streams only ordered stage metadata and one final safe result", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
    const response = await handleRequest(draftRequest(structuredPayload(), TESTING_ORIGIN, true), workerEnv(), draftOptions({ anthropicFetch }));
    const body = await response.text();
    const events = parseSseEvents(body);

    expect(events.map(({ event, data }) => [event, data.stage, data.status])).toEqual([
      ["stage", "analyzing", "in-progress"],
      ["stage", "analyzing", "done"],
      ["stage", "drafting", "in-progress"],
      ["stage", "drafting", "done"],
      ["stage", "reviewing", "in-progress"],
      ["stage", "reviewing", "done"],
      ["stage", "finalizing", "in-progress"],
      ["stage", "finalizing", "done"],
      ["result", undefined, undefined],
    ]);
    expect(events.at(-1)?.data).toEqual(expectedDraftResult("anthropic"));
    expect(body).not.toContain("scores");
    expect(body).not.toContain("replyPlan");
    expect(body).not.toContain("runtime-secret");
  });

  it("returns only categorical primary and fallback diagnostics when both providers fail", async () => {
    const env = workerEnv();
    env.AI.run = vi.fn(async () => ({ response: "not-json" }));
    const anthropicFetch = vi.fn(async () => anthropicResponse({ invalid: "analysis" }));
    const logError = vi.fn();
    const response = await handleRequest(draftRequest(structuredPayload(), TESTING_ORIGIN, true), env, draftOptions({ anthropicFetch, logError }));
    const body = await response.text();
    const events = parseSseEvents(body);

    expect(events.at(-1)).toEqual({
      event: "error",
      data: {
        error: "Cloud AI could not produce a safe draft. Please try again.",
        code: "pipeline_failed",
      },
    });
    expect(body).not.toContain("runtime-secret");
    expect(body).not.toContain("not-json");
    expect(body).not.toContain("Could you share the role details?");
    expect(logError).toHaveBeenCalledWith({
      event: "draft_pipeline_failed",
      primary: { provider: "anthropic", kind: "quality", code: "analysis_schema" },
      fallback: { provider: "cloudflare", kind: "quality", code: "analysis_schema" },
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain("Could you share the role details?");
    expect(JSON.stringify(logError.mock.calls)).not.toContain("not-json");
  });

  it("rejects invalid stage and oversized guidelines before inference", async () => {
    for (const [payload, expectedStatus] of [
      [structuredPayload({ relationshipStage: "invented-stage" }), 400],
      [structuredPayload({ personalGuidelines: "x".repeat(2_001) }), 413],
    ]) {
      const env = workerEnv();
      const response = await handleRequest(draftRequest(payload), env, { verifyAccess, anthropicFetch: vi.fn() });
      expect(response.status).toBe(expectedStatus);
      expect(env.AI.run).not.toHaveBeenCalled();
    }
  });

  it("rejects unauthenticated and cross-origin requests before rate limiting or inference", async () => {
    const unauthenticatedEnv = workerEnv();
    const unauthenticated = await handleRequest(new Request(`${TESTING_ORIGIN}/api/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(structuredPayload()),
    }), unauthenticatedEnv, { verifyAccess });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticatedEnv.DRAFT_RATE_LIMITER.limit).not.toHaveBeenCalled();

    const crossOriginEnv = workerEnv();
    const crossOrigin = await handleRequest(draftRequest(structuredPayload(), "https://attacker.example"), crossOriginEnv, { verifyAccess });
    expect(crossOrigin.status).toBe(403);
    expect(crossOriginEnv.DRAFT_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated learning decision before reading its request body", async () => {
    const env = workerEnv();
    const request = new Request(`${TESTING_ORIGIN}/api/learning/decisions/learning-decision-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: { action: "useful" } }),
    });
    const readBody = vi.spyOn(request, "text");
    const response = await handleRequest(request, env, { verifyAccess });
    expect(response.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(env.DRAFT_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("authenticates usage reads before rate limiting and returns a no-store current-account summary", async () => {
    const unauthenticatedEnv = workerEnv();
    const unauthenticated = await handleRequest(new Request(`${TESTING_ORIGIN}/api/usage`), unauthenticatedEnv, { verifyAccess });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticatedEnv.DRAFT_RATE_LIMITER.limit).not.toHaveBeenCalled();

    const authenticatedEnv = workerEnv();
    const query = vi.fn().mockResolvedValue({ rows: [
      { provider: "anthropic", model_id: null, monthly_allowance_micro_usd: null },
      { provider: "workers_ai", model_id: null, monthly_allowance_micro_usd: null },
    ] });
    const authenticated = await handleRequest(new Request(`${TESTING_ORIGIN}/api/usage`, {
      headers: { "Cf-Access-Jwt-Assertion": SYNTHETIC_ASSERTION },
    }), authenticatedEnv, { verifyAccess, query, now: new Date("2026-08-09T12:00:00.000Z") });
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("Cache-Control")).toBe("no-store");
    expect(authenticatedEnv.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: expect.stringMatching(/^usage:[0-9a-f]{64}$/u),
    });
    expect(query.mock.calls[0][2][0]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps the authenticated encrypted-vault route available", async () => {
    const env = workerEnv();
    const response = await handleRequest(new Request(`${TESTING_ORIGIN}/api/vault`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }), env, { verifyAccess });
    expect(response.status).toBe(401);
  });
});
