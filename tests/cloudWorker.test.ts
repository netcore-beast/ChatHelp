import { describe, expect, it, vi } from "vitest";
import { handleRequest, sha256Hex, WORKERS_AI_MODEL } from "../cloudflare/worker/src/index.js";

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
  it("reports a storage-free health boundary without authentication", async () => {
    const response = await handleRequest(new Request("https://chathelp.example/health"), await workerEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
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
    });
    expect(env.DRAFT_RATE_LIMITER.limit).toHaveBeenCalledTimes(1);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const [, input] = env.AI.run.mock.calls[0];
    expect(input.messages[1].content).toContain("Relevant conversation text only");
    expect(input.messages[1].content).not.toContain(ACCESS_CODE);
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
