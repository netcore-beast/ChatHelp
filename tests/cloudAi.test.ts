import { describe, expect, it, vi } from "vitest";
import { buildPrompt, generateWithCloud, parseDrafts, type PrivateAiInput } from "../src/lib/privateAi";
import { selectRelevantContext } from "../src/lib/retrieval";

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
    expect(init.credentials).toBe("same-origin");
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

  it("explains when Cloudflare Access returns a sign-in page instead of Worker JSON", async () => {
    const request = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Sign in</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));

    await expect(generateWithCloud(input(), {
      accessToken: "a-valid-access-token-with-enough-length",
      consentedAt: "2026-08-01T00:00:00.000Z",
      rememberAccessToken: false,
    }, undefined, request as unknown as typeof fetch)).rejects.toThrow(/Cloudflare sign-in session could not be verified/);
  });

  it("tells the model which person is the sender and requires paste-ready text", () => {
    const prompt = buildPrompt(input());
    expect(prompt).toContain("USER is the person operating ChatHelp");
    expect(prompt).toContain("CONTACT is the selected recipient");
    expect(prompt).toContain("paste-ready message text only");
    expect(prompt).toContain("do not claim one exists");
  });

  it("always includes Amit's captured conversation even when the generic agenda has no keyword match", () => {
    const capturedText = `Jan 20, 2024
Ankush
Hi

Ankush
Hi Amit, how are you? Happy to connect!(Edited)

Amit
Happy to connect with you as well. I saw your profile and it looks very eye captive . Specially your recent work.

Ankush
Hi Amit, hope you're doing well. I noticed your profile and thought it would be great to connect. How's your work going?`;
    const document = {
      id: "amit-chat-screen",
      name: "LinkedIn conversation screen with Amit",
      text: capturedText,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const amitInput: PrivateAiInput = {
      ...input(),
      contact: {
        ...input().contact,
        name: "Amit",
        chat: [],
        documents: [document],
      },
      latestQuestion: "Keep the discussion engaging and relationship-focused.",
      retrievedContext: selectRelevantContext([document], "networking job opportunities and rapport"),
    };

    expect(amitInput.retrievedContext).toEqual([]);
    const prompt = buildPrompt(amitInput);
    expect(prompt).toContain("CAPTURED LINKEDIN CONVERSATION TEXT (mandatory conversation evidence)");
    expect(prompt).toContain(capturedText);
    expect(prompt).toContain("identify the latest meaningful message and its sender");
    expect(prompt).toContain("Never repeat or closely paraphrase a message the USER already sent");
    expect(prompt).toContain("CURRENT TASK OR AGENDA (intent only; not conversation evidence)");
    expect(prompt.length).toBeLessThanOrEqual(24_000);
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
