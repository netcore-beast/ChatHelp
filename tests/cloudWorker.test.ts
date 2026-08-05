import { describe, expect, it, vi } from "vitest";
import { GPT_REVIEW_MODEL, LLAMA_CANDIDATE_MODEL, handleRequest, sha256Hex, WORKERS_AI_MODEL } from "../cloudflare/worker/src/index.js";

const ACCESS_CODE = "test-access-code-with-more-than-twenty-characters";

async function workerEnv() {
  return {
    CHATHELP_ACCESS_TOKEN_HASH: await sha256Hex(ACCESS_CODE),
    DRAFT_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    AI: {
      run: vi.fn().mockResolvedValue({
        response: {
          drafts: ["First professional reply", "Second professional reply", "Third professional reply"],
        },
      }),
    },
  };
}

describe("Cloudflare private inference Worker", () => {
  it("uses Llama candidates plus GPT-OSS final review in automatic mode", () => {
    expect(LLAMA_CANDIDATE_MODEL).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
    expect(GPT_REVIEW_MODEL).toBe("@cf/openai/gpt-oss-120b");
    expect(WORKERS_AI_MODEL).toBe("auto:llama-3.1-8b+gpt-oss-120b");
  });

  it("reports a storage-free health boundary without authentication", async () => {
    const response = await handleRequest(new Request("https://chathelp.example/health"), await workerEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      model: WORKERS_AI_MODEL,
      models: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      mode: "automatic-two-model-review",
      persistentStorage: false,
      aiGateway: false,
      observability: false,
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects unauthenticated draft requests before inference", async () => {
    const env = await workerEnv();
    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Draft a reply" }),
    }), env);

    expect(response.status).toBe(401);
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(env.DRAFT_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it("rate-limits an authenticated code and returns exactly three drafts", async () => {
    const env = await workerEnv();
    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ACCESS_CODE,
        "Content-Type": "application/json",
        Origin: "https://chathelp.example",
      },
      body: JSON.stringify({ prompt: "Relevant conversation text only" }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      drafts: ["First professional reply", "Second professional reply", "Third professional reply"],
      model: WORKERS_AI_MODEL,
      models: [LLAMA_CANDIDATE_MODEL, GPT_REVIEW_MODEL],
      mode: "automatic-two-model-review",
    });
    expect(env.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledTimes(1);
    expect(env.AI.run).toHaveBeenCalledTimes(2);
    const [candidateModel, candidateInput] = env.AI.run.mock.calls[0];
    const [reviewModel, reviewInput] = env.AI.run.mock.calls[1];
    expect(candidateModel).toBe(LLAMA_CANDIDATE_MODEL);
    expect(reviewModel).toBe(GPT_REVIEW_MODEL);
    expect(candidateInput.response_format.type).toBe("json_schema");
    expect(reviewInput.response_format).toBeUndefined();
    expect(reviewInput.messages[0].content).toContain("conversation-list previews");
    expect(reviewInput.messages[0].content).toContain("job cards");
    expect(reviewInput.messages[0].content).toContain("HIGHEST PRIORITY REPLY TARGET");
    expect(reviewInput.messages[0].content).toContain("previous local draft suggestions");
    expect(reviewInput.messages[1].content).toContain("Relevant conversation text only");
    expect(reviewInput.messages[1].content).toContain("LLAMA 3.1 8B CANDIDATES");
    expect(reviewInput.messages[1].content).not.toContain(ACCESS_CODE);
  });

  it("places the selected role, full reply rules, and optional-objective policy in the model instructions", async () => {
    const env = await workerEnv();
    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ACCESS_CODE,
        "Content-Type": "application/json",
        Origin: "https://chathelp.example",
      },
      body: JSON.stringify({
        prompt: "HIGHEST PRIORITY REPLY TARGET\nAlex: What role did you have in mind?",
        playbook: {
          role: "Human Resource",
          relationshipGoal: "Clarify the opportunity",
          voice: "Direct and considerate",
          replyRules: "Do not mention compensation unless Alex asks. FINAL-RULE-MARKER",
        },
        replyObjective: "",
      }),
    }), env);

    expect(response.status).toBe(200);
    const [candidateModel, candidateInput] = env.AI.run.mock.calls[0];
    const [reviewModel, reviewInput] = env.AI.run.mock.calls[1];
    expect(candidateModel).toBe(LLAMA_CANDIDATE_MODEL);
    expect(reviewModel).toBe(GPT_REVIEW_MODEL);
    for (const input of [candidateInput, reviewInput]) {
      expect(input.messages[0].content).toContain("Selected role: Human Resource");
      expect(input.messages[0].content).toContain("FINAL-RULE-MARKER");
      expect(input.messages[0].content).toContain("The USER added no reply objective");
      expect(input.messages[1].content).toContain("Alex: What role did you have in mind?");
    }
    expect(candidateInput.response_format.type).toBe("json_schema");
    expect(reviewInput.response_format).toBeUndefined();
  });

  it("makes a provided objective additive to the conversation and playbook", async () => {
    const env = await workerEnv();
    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ACCESS_CODE,
        "Content-Type": "application/json",
        Origin: "https://chathelp.example",
      },
      body: JSON.stringify({
        prompt: "Taylor: Could you send the details?",
        playbook: { role: "Job Seeker", relationshipGoal: "Learn about the role", voice: "Concise", replyRules: "No invented experience" },
        replyObjective: "Ask when applications close",
      }),
    }), env);

    expect(response.status).toBe(200);
    const [, reviewInput] = env.AI.run.mock.calls[1];
    expect(reviewInput.messages[0].content).toContain("Ask when applications close");
    expect(reviewInput.messages[0].content).toContain("together with the actual conversation and every playbook rule");
  });

  it("recovers when GPT-OSS adds text around JSON instead of using JSON Schema mode", async () => {
    const env = await workerEnv();
    env.AI.run
      .mockResolvedValueOnce({ response: { drafts: ["Candidate one", "Candidate two", "Candidate three"] } })
      .mockResolvedValueOnce({ response: "Final review complete.\n{\"drafts\":[\"Reviewed one\",\"Reviewed two\",\"Reviewed three\"]}" });
    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: { Authorization: "Bearer " + ACCESS_CODE, "Content-Type": "application/json", Origin: "https://chathelp.example" },
      body: JSON.stringify({ prompt: "Alex: Can you share more?" }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ drafts: ["Reviewed one", "Reviewed two", "Reviewed three"] });
    expect(env.AI.run.mock.calls[1][1].response_format).toBeUndefined();
  });

  it("parses the OpenAI-compatible choices response returned by Cloudflare GPT-OSS", async () => {
    const env = await workerEnv();
    env.AI.run
      .mockResolvedValueOnce({ response: { drafts: ["Candidate one", "Candidate two", "Candidate three"] } })
      .mockResolvedValueOnce({
        choices: [{
          finish_reason: "stop",
          message: {
            content: "{\"drafts\":[\"Cloudflare one\",\"Cloudflare two\",\"Cloudflare three\"]}",
            reasoning: "Synthetic reasoning metadata",
            role: "assistant",
          },
        }],
      });

    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: { Authorization: "Bearer " + ACCESS_CODE, "Content-Type": "application/json", Origin: "https://chathelp.example" },
      body: JSON.stringify({ prompt: "Alex: Can you share more?" }),
    }), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      drafts: ["Cloudflare one", "Cloudflare two", "Cloudflare three"],
    });
    expect(env.AI.run).toHaveBeenCalledTimes(2);
  });

  it("retries GPT-OSS once when its first final review is not parseable JSON", async () => {
    const env = await workerEnv();
    env.AI.run
      .mockResolvedValueOnce({ response: { drafts: ["Candidate one", "Candidate two", "Candidate three"] } })
      .mockResolvedValueOnce({ response: "not valid JSON" })
      .mockResolvedValueOnce({ response: "{\"drafts\":[\"Recovered one\",\"Recovered two\",\"Recovered three\"]}" });
    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: { Authorization: "Bearer " + ACCESS_CODE, "Content-Type": "application/json", Origin: "https://chathelp.example" },
      body: JSON.stringify({ prompt: "Alex: Can you share more?" }),
    }), env);

    expect(response.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledTimes(3);
    expect(env.AI.run.mock.calls[2][1].messages[1].content).toContain("FORMAT CORRECTION");
  });

  it("automatically retries when the model copies a message from captured history", async () => {
    const env = await workerEnv();
    env.AI.run
      .mockResolvedValueOnce({ response: { drafts: ["Candidate one", "Candidate two", "Candidate three"] } })
      .mockResolvedValueOnce({ response: { drafts: [
        "Hi Amit, hope you're doing well. How's your work going?",
        "Hi Amit, just checking in.",
        "Hi Amit, what have you been working on lately?",
      ] } })
      .mockResolvedValueOnce({ response: { drafts: [
        "Hi Amit, thanks again for the kind words about my recent work. What have you been focused on lately?",
        "Hi Amit, I appreciated your thoughtful note about my recent work. I’d enjoy hearing what you’re building these days.",
        "Hi Amit, it’s been a while since we connected. I’d be glad to catch up here and hear what’s new with you.",
      ] } });
    const prompt = "CAPTURED LINKEDIN CONVERSATION TEXT\nHi Amit, hope you're doing well. How's your work going?";

    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ACCESS_CODE,
        "Content-Type": "application/json",
        Origin: "https://chathelp.example",
      },
      body: JSON.stringify({ prompt }),
    }), env);

    expect(response.status).toBe(200);
    expect(env.AI.run).toHaveBeenCalledTimes(3);
    const body = await response.json();
    expect(body.drafts[0]).toContain("kind words about my recent work");
    expect(env.AI.run.mock.calls[2][1].messages[1].content).toContain("QUALITY CORRECTION");
  });

  it("blocks cross-origin requests even with a valid access code", async () => {
    const env = await workerEnv();
    const response = await handleRequest(new Request("https://chathelp.example/api/drafts", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ACCESS_CODE,
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ prompt: "Draft a reply" }),
    }), env);
    expect(response.status).toBe(403);
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
