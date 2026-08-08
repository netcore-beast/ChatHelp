import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_MODEL,
  GPT_REVIEW_MODEL,
  LLAMA_CANDIDATE_MODEL,
  PIPELINE_MODE,
  WORKERS_AI_MODEL,
  handleRequest,
} from "../cloudflare/worker/src/index.js";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const TESTING_ORIGIN = `https://${TESTING_HOST}`;
const SYNTHETIC_ASSERTION = "synthetic.assertion.value";

const ANALYSIS = {
  storedStage: "learn_interests",
  observedStage: "identify_need",
  effectiveStage: "identify_need",
  nextAllowedStage: "identify_need",
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
    stage: "identify_need",
    goal: "Answer briefly and clarify the priority.",
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
  total: 100,
  criticalFailures: [],
  rewritten: false,
  finalDraft: CANDIDATE.draft.text,
};

function structuredPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversationContext: "<conversation_context>\n{\"recentMessages\":[{\"id\":\"m1\",\"sender\":\"CONTACT\",\"text\":\"Could you share the role details?\"}]}\n</conversation_context>",
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
    learningExamples: [],
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

const verifyAccess = vi.fn(async (_assertion: string, options: { issuer: string; audience: string }) => ({
  payload: { iss: options.issuer, aud: [options.audience], sub: "synthetic-subject", exp: 2_000_000_000 },
}));

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
  it("reports safe primary/fallback configuration without any configuration value", async () => {
    const env = workerEnv();
    const response = await handleRequest(new Request(`${TESTING_ORIGIN}/health`), env, { verifyAccess });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      provider: "anthropic-primary-cloudflare-fallback",
      model: ANTHROPIC_MODEL,
      models: [ANTHROPIC_MODEL, LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      fallbackModel: WORKERS_AI_MODEL,
      fallbackModels: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      mode: PIPELINE_MODE,
      anthropicConfigured: true,
      authentication: "cloudflare-access-jwt",
      persistentStorage: "client-encrypted-neon",
    });
    const text = await (await handleRequest(new Request(`${TESTING_ORIGIN}/health`), env, { verifyAccess })).text();
    expect(text).not.toContain("runtime-secret");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses Claude successfully without invoking either fallback model", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
    const env = workerEnv();
    const response = await handleRequest(draftRequest(structuredPayload()), env, { verifyAccess, anthropicFetch });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: REVIEW.finalDraft,
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "stage-aware-single-draft-v1",
    });
    expect(anthropicFetch).toHaveBeenCalledTimes(3);
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
      verifyAccess,
      anthropicFetch,
      anthropicTimeoutMs: 1,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: REVIEW.finalDraft,
      provider: "cloudflare",
      model: WORKERS_AI_MODEL,
      mode: "stage-aware-single-draft-v1",
    });
    expect(env.AI.run).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 400])("uses the permanent fallback for Anthropic HTTP %s", async (status) => {
    const env = workerEnv();
    const anthropicFetch = vi.fn(async () => new Response("synthetic provider detail", { status }));
    const response = await handleRequest(draftRequest(structuredPayload()), env, { verifyAccess, anthropicFetch });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      draft: REVIEW.finalDraft,
      provider: "cloudflare",
      model: WORKERS_AI_MODEL,
      mode: "stage-aware-single-draft-v1",
    });
    expect(env.AI.run).toHaveBeenCalledTimes(3);
  });

  it("uses the permanent fallback when Claude returns invalid quality or a critical policy failure", async () => {
    for (const responses of [
      [{ invalid: "analysis" }],
      [ANALYSIS, CANDIDATE, { ...REVIEW, criticalFailures: ["premature_pitch"] }],
    ]) {
      const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
      const env = workerEnv();
      const response = await handleRequest(draftRequest(structuredPayload()), env, { verifyAccess, anthropicFetch });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        draft: REVIEW.finalDraft,
        provider: "cloudflare",
        model: WORKERS_AI_MODEL,
        mode: "stage-aware-single-draft-v1",
      });
      expect(env.AI.run).toHaveBeenCalledTimes(3);
    }
  });

  it("streams only ordered stage metadata and one final safe result", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const anthropicFetch = vi.fn(async () => anthropicResponse(responses.shift()));
    const response = await handleRequest(draftRequest(structuredPayload(), TESTING_ORIGIN, true), workerEnv(), { verifyAccess, anthropicFetch });
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
    expect(events.at(-1)?.data).toEqual({ draft: REVIEW.finalDraft, provider: "anthropic", model: "claude-opus-4-6", mode: "stage-aware-single-draft-v1" });
    expect(body).not.toContain("scores");
    expect(body).not.toContain("replyPlan");
    expect(body).not.toContain("runtime-secret");
  });

  it("returns only categorical primary and fallback diagnostics when both providers fail", async () => {
    const env = workerEnv();
    env.AI.run = vi.fn(async () => ({ response: "not-json" }));
    const anthropicFetch = vi.fn(async () => anthropicResponse({ invalid: "analysis" }));
    const response = await handleRequest(draftRequest(structuredPayload(), TESTING_ORIGIN, true), env, { verifyAccess, anthropicFetch });
    const body = await response.text();
    const events = parseSseEvents(body);

    expect(events.at(-1)).toEqual({
      event: "error",
      data: {
        error: "Cloud AI could not produce a safe draft. Please try again. Diagnostic: anthropic_quality__cloudflare_quality",
        diagnosticCode: "anthropic_quality__cloudflare_quality",
      },
    });
    expect(body).not.toContain("runtime-secret");
    expect(body).not.toContain("not-json");
    expect(body).not.toContain("Could you share the role details?");
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
