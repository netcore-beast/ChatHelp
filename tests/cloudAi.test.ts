import { describe, expect, it, vi } from "vitest";
import { buildPrompt, generateWithCloud, parseDrafts, type PrivateAiInput } from "../src/lib/privateAi";

function input(): PrivateAiInput {
  return {
    contact: {
      id: "contact-1",
      name: "Alex",
      headline: "People leader",
      profileNotes: "Prefers concise messages",
      platform: "linkedin",
      platformUrl: "",
      chat: [
        { id: "m1", role: "them", body: "Could you share the role details?", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      documents: [],
      outcomes: [],
      retentionDays: 90,
    },
    guidance: {
      role: "Recruiter",
      objective: "Arrange a short call",
      voice: "Warm and concise",
      boundaries: "No pressure",
    },
    latestQuestion: "Answer Alex and suggest two times.",
    retrievedContext: [],
    feedbackSummary: "",
    outcomeSummary: "",
  };
}

describe("cloud AI client boundary", () => {
  it("requires explicit consent before making a network request", async () => {
    const request = vi.fn();
    await expect(generateWithCloud(input(), {
      accessToken: "a-valid-access-token-with-enough-length",
      consentedAt: "",
      rememberAccessToken: false,
    }, undefined, request as unknown as typeof fetch)).rejects.toThrow(/Confirm the cloud privacy notice/);
    expect(request).not.toHaveBeenCalled();
  });

  it("sends one minimized prompt to the same-origin Worker", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      drafts: ["Draft one", "Draft two", "Draft three"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const accessToken = "a-valid-access-token-with-enough-length";

    await expect(generateWithCloud(input(), {
      accessToken,
      consentedAt: "2026-08-01T00:00:00.000Z",
      rememberAccessToken: false,
    }, undefined, request as unknown as typeof fetch)).resolves.toEqual(["Draft one", "Draft two", "Draft three"]);

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("/api/drafts");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.headers.Authorization).toBe("Bearer " + accessToken);
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(["prompt"]);
    expect(body.prompt).toContain("Alex: Could you share the role details?");
    expect(body.prompt).toContain("Voice: Warm and concise");
    expect(body.prompt).not.toContain(accessToken);
    expect(body.prompt.length).toBeLessThanOrEqual(24_000);
  });

  it("surfaces the Worker's safe error message", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Invalid ChatHelp access code.",
    }), { status: 401, headers: { "Content-Type": "application/json" } }));

    await expect(generateWithCloud(input(), {
      accessToken: "an-invalid-access-token-with-enough-length",
      consentedAt: "2026-08-01T00:00:00.000Z",
      rememberAccessToken: false,
    }, undefined, request as unknown as typeof fetch)).rejects.toThrow("Invalid ChatHelp access code.");
  });

  it("tells the model which person is the sender and requires paste-ready text", () => {
    const prompt = buildPrompt(input());
    expect(prompt).toContain("USER is the person operating ChatHelp");
    expect(prompt).toContain("CONTACT is the selected recipient");
    expect(prompt).toContain("paste-ready message text only");
    expect(prompt).toContain("do not claim one exists");
  });

  it("removes leaked style headings and formal Dear greetings from cloud drafts", () => {
    const drafts = parseDrafts(JSON.stringify([
      "Warm and Concise, Acknowledging Contact and Suggesting Low-Pressure Next Step Dear Ankush, thanks for reaching out.",
      "Curious and Relationship-Focused, With One Thoughtful Question Hi Ankush, what would be most useful to discuss?",
      "Option 3: Dear Ankush, I can share a little more context here.",
    ]));

    expect(drafts).toEqual([
      "Hi Ankush, thanks for reaching out.",
      "Hi Ankush, what would be most useful to discuss?",
      "Hi Ankush, I can share a little more context here.",
    ]);
  });
});
