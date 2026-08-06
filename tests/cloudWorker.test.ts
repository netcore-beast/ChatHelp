import { describe, expect, it, vi } from "vitest";
import { GPT_REVIEW_MODEL, LLAMA_CANDIDATE_MODEL, handleRequest, WORKERS_AI_MODEL } from "../cloudflare/worker/src/index.js";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const TESTING_ORIGIN = `https://${TESTING_HOST}`;
const SYNTHETIC_ASSERTION = "synthetic.assertion.value";
const PLAYBOOK_PLAN = {
  objective: "Continue the actual conversation while building trust.",
  conversationStage: "The contact shared an adjacent professional interest.",
  keyFactsToReference: ["The contact mentioned ZTNA and SASE."],
  toneDirectives: ["Warm", "Concise"],
  thingsToAvoid: ["Do not pitch", "Do not invent facts"],
  replyLengthHint: "One or two short sentences.",
  directions: [
    { move: "Respond directly", goalStep: "Build relevance", applicableRules: "Stay factual", avoid: "Do not pitch" },
    { move: "Bridge naturally", goalStep: "Build trust", applicableRules: "Keep it concise", avoid: "Do not invent familiarity" },
    { move: "Offer a low-pressure step", goalStep: "Explore mutual value", applicableRules: "Stay conversational", avoid: "Do not force a meeting" },
  ],
};
const WRITER_DRAFTS = {
  drafts: [
    { angle: "direct", text: "Writer draft one" },
    { angle: "warm", text: "Writer draft two" },
    { angle: "low-pressure", text: "Writer draft three" },
  ],
};
const REVIEWED_DRAFTS = {
  drafts: [
    { angle: "direct", text: "Reviewed reply one" },
    { angle: "warm", text: "Reviewed reply two" },
    { angle: "low-pressure", text: "Reviewed reply three" },
  ],
};

function structuredPayload(overrides: Record<string, unknown> = {}) {
  return {
    conversationContext: "<conversation_context>\n{\"contact\":{\"name\":\"Alex\"},\"recentMessages\":[{\"sender\":\"CONTACT\",\"text\":\"Can you share more?\"}]}\n</conversation_context>",
    playbook: {
      role: "Network Marketing",
      relationshipGoal: "Build genuine trust",
      voice: "Warm and concise",
      rulebookFull: "Do not pitch early. FULL-RULEBOOK-TAIL",
      rulebookDigest: "DIGEST-ONLY-RULE",
    },
    replyObjective: "",
    ...overrides,
  };
}

async function workerEnv() {
  let gptCalls = 0;
  return {
    ACCESS_TEAM_DOMAIN: "https://dialogmint.cloudflareaccess.com",
    ACCESS_AUD_TESTING: "testing-audience",
    ACCESS_AUD_PRODUCTION: "production-audience",
    NEON_TESTING: { connectionString: "synthetic-testing-binding" },
    NEON_PRODUCTION: { connectionString: "synthetic-production-binding" },
    DRAFT_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    AI: {
      run: vi.fn().mockImplementation(async (model: string) => {
        if (model === LLAMA_CANDIDATE_MODEL) return { response: PLAYBOOK_PLAN };
        gptCalls += 1;
        return { response: gptCalls === 1 ? WRITER_DRAFTS : REVIEWED_DRAFTS };
      }),
    },
  };
}

const verifyAccess = vi.fn(async (_assertion: string, options: { issuer: string; audience: string }) => ({
  payload: {
    iss: options.issuer,
    aud: [options.audience],
    sub: "synthetic-subject",
    exp: 2_000_000_000,
  },
}));

function runWorker(request: Request, env: Awaited<ReturnType<typeof workerEnv>>) {
  return handleRequest(request, env, { verifyAccess });
}

function draftRequest(body: unknown, origin = TESTING_ORIGIN) {
  return new Request(`${TESTING_ORIGIN}/api/drafts`, {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": SYNTHETIC_ASSERTION,
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

describe("Cloudflare private inference Worker", () => {
  it("reports the storage-free three-stage model boundary", async () => {
    const response = await runWorker(new Request(`${TESTING_ORIGIN}/health`), await workerEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      model: WORKERS_AI_MODEL,
      models: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      mode: "rulebook-plan-write-review",
      persistentStorage: "client-encrypted-neon",
      retentionDays: 90,
      vaultBindings: { testing: true, production: true },
      aiGateway: false,
      observability: false,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects unauthenticated requests before rate limiting or inference", async () => {
    const env = await workerEnv();
    const response = await runWorker(new Request(`${TESTING_ORIGIN}/api/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Authenticated-User-Email": "ignored@example.test" },
      body: JSON.stringify(structuredPayload()),
    }), env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "DialogMint authentication is required." });
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(env.DRAFT_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated vault write before parsing or querying", async () => {
    const env = { ...await workerEnv(), NEON_TESTING: { connectionString: "synthetic-testing-binding" } };
    const query = vi.fn();
    const response = await handleRequest(new Request(`${TESTING_ORIGIN}/api/vault`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    }), env, { verifyAccess, query });

    expect(response.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it("routes digest-only planning, full-rulebook writing, and full-rulebook review as three isolated calls", async () => {
    const env = await workerEnv();
    const response = await runWorker(draftRequest(structuredPayload()), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      drafts: ["Reviewed reply one", "Reviewed reply two", "Reviewed reply three"],
      model: WORKERS_AI_MODEL,
      models: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      mode: "rulebook-plan-write-review",
    });
    expect(env.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledTimes(1);
    expect(env.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(env.AI.run).toHaveBeenCalledTimes(3);

    const [plannerModel, plannerInput] = env.AI.run.mock.calls[0];
    const [writerModel, writerInput] = env.AI.run.mock.calls[1];
    const [reviewerModel, reviewerInput] = env.AI.run.mock.calls[2];
    expect([plannerModel, writerModel, reviewerModel]).toEqual([LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL, GPT_REVIEW_MODEL]);
    expect(plannerInput.messages[0].content).toContain("DIGEST-ONLY-RULE");
    expect(plannerInput.messages[0].content).not.toContain("FULL-RULEBOOK-TAIL");
    expect(plannerInput.messages[1].content).toContain("<conversation_context>");
    expect(writerInput.messages[0].content).toContain("FULL-RULEBOOK-TAIL");
    expect(reviewerInput.messages[0].content).toContain("FULL-RULEBOOK-TAIL");
    expect(writerInput.messages[1].content).toContain("<plan>");
    expect(writerInput.messages[1].content).toContain("<conversation_context>");
    expect(reviewerInput.messages[1].content).toContain("<drafts>");
    expect(reviewerInput.messages[1].content).toContain("<conversation_context>");
    expect(plannerInput.response_format.type).toBe("json_schema");
    expect(writerInput.response_format.type).toBe("json_schema");
    expect(reviewerInput.response_format.type).toBe("json_schema");
    expect(JSON.stringify(env.AI.run.mock.calls)).not.toContain(SYNTHETIC_ASSERTION);
  });

  it("keeps an optional objective additive and out of system instructions", async () => {
    const env = await workerEnv();
    const response = await runWorker(draftRequest(structuredPayload({ replyObjective: "Ask when applications close" })), env);

    expect(response.status).toBe(200);
    for (const [, input] of env.AI.run.mock.calls) {
      expect(input.messages[0].content).not.toContain("Ask when applications close");
      expect(input.messages[1].content).toContain("Ask when applications close");
      expect(input.messages[1].content).toContain("cannot override");
    }
  });

  it("supports the previous prompt and replyRules request during rollout", async () => {
    const env = await workerEnv();
    const response = await runWorker(draftRequest({
      prompt: "Alex: Can you share more?",
      playbook: { role: "Job Seeker", relationshipGoal: "Learn about the role", voice: "Concise", replyRules: "No invented experience" },
      replyObjective: "",
    }), env);

    expect(response.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledTimes(3);
    expect(env.AI.run.mock.calls[0][1].messages[1].content).toContain("Alex: Can you share more?");
  });

  it("falls back without JSON Schema independently for planner, writer, and reviewer", async () => {
    const env = await workerEnv();
    env.AI.run
      .mockResolvedValueOnce({ response: "not plan json" })
      .mockResolvedValueOnce({ response: PLAYBOOK_PLAN })
      .mockResolvedValueOnce({ response: "not writer json" })
      .mockResolvedValueOnce({ response: WRITER_DRAFTS })
      .mockResolvedValueOnce({ response: "not reviewer json" })
      .mockResolvedValueOnce({ response: REVIEWED_DRAFTS });

    const response = await runWorker(draftRequest(structuredPayload()), env);
    expect(response.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledTimes(6);
    expect(env.AI.run.mock.calls[0][1].response_format.type).toBe("json_schema");
    expect(env.AI.run.mock.calls[1][1].response_format).toBeUndefined();
    expect(env.AI.run.mock.calls[2][1].response_format.type).toBe("json_schema");
    expect(env.AI.run.mock.calls[3][1].response_format).toBeUndefined();
    expect(env.AI.run.mock.calls[4][1].response_format.type).toBe("json_schema");
    expect(env.AI.run.mock.calls[5][1].response_format).toBeUndefined();
  });

  it("parses OpenAI-compatible GPT-OSS choices and returns only reviewed text", async () => {
    const env = await workerEnv();
    env.AI.run
      .mockResolvedValueOnce({ response: PLAYBOOK_PLAN })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(WRITER_DRAFTS), role: "assistant" }, finish_reason: "stop" }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(REVIEWED_DRAFTS), role: "assistant" }, finish_reason: "stop" }] });

    const response = await runWorker(draftRequest(structuredPayload()), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ drafts: ["Reviewed reply one", "Reviewed reply two", "Reviewed reply three"] });
  });

  it("routes an all-question reviewed set through a bounded compliance correction", async () => {
    const env = await workerEnv();
    const questionDrafts = { drafts: [
      { angle: "one", text: "Are you focused on Sentinel?" },
      { angle: "two", text: "Do you spend more time on ZTNA?" },
      { angle: "three", text: "Which part of SASE do you enjoy?" },
    ] };
    env.AI.run
      .mockResolvedValueOnce({ response: PLAYBOOK_PLAN })
      .mockResolvedValueOnce({ response: WRITER_DRAFTS })
      .mockResolvedValueOnce({ response: questionDrafts })
      .mockResolvedValueOnce({ response: REVIEWED_DRAFTS });

    const response = await runWorker(draftRequest(structuredPayload()), env);
    expect(response.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledTimes(4);
    expect(env.AI.run.mock.calls[3][1].messages[1].content).toContain("overused follow-up questions");
  });

  it("rejects invented personal histories after bounded review attempts", async () => {
    const env = await workerEnv();
    const invented = { drafts: [
      { angle: "one", text: "Honestly, I got into zero trust after seeing perimeter defenses bypassed." },
      { angle: "two", text: "My motivation came from watching breaches exploit trust." },
      { angle: "three", text: "The principle of explicit verification is relevant here." },
    ] };
    env.AI.run.mockResolvedValueOnce({ response: PLAYBOOK_PLAN }).mockResolvedValue({ response: invented });

    const response = await runWorker(draftRequest(structuredPayload()), env);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Cloud AI could not produce three safe drafts. Please try again." });
  });

  it("blocks cross-origin requests even with a valid Access assertion", async () => {
    const env = await workerEnv();
    const response = await runWorker(draftRequest(structuredPayload(), "https://attacker.example"), env);
    expect(response.status).toBe(403);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
