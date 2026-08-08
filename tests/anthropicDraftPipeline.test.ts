import { describe, expect, it, vi } from "vitest";
import {
  AnthropicPipelineError,
  runAnthropicDraftPipeline,
} from "../cloudflare/worker/src/anthropicDraftPipeline.js";

const CONTEXT = {
  conversationContext: "<conversation_context>\n{\"recentMessages\":[{\"sender\":\"CONTACT\",\"text\":\"Could you share the role details?\"}]}\n</conversation_context>",
  latestMeaningfulIncoming: {
    id: "m1",
    sender: "CONTACT",
    speaker: "Alex",
    text: "Could you share the role details?",
    timestamp: "2026-01-01T00:00:00.000Z",
  },
  playbook: {
    role: "Human Resource",
    relationshipGoal: "Build trust before discussing a role",
    voice: "Warm and concise",
    rulebookFull: "FULL-RULEBOOK: Never pressure the contact.",
    rulebookDigest: "DIGEST: No pressure.",
  },
  personalGuidelines: "Use plain language and one useful question.",
  conversationGoal: "Learn which role detail matters most.",
  relationshipStage: "learn_interests",
  knownFacts: ["The contact asked for role details."],
  unansweredQuestions: ["Which detail matters most?"],
  learningExamples: [],
  replyObjective: "Answer directly, then clarify their priority.",
};

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
  prohibitedMoves: ["Do not pitch", "Do not invent details"],
  replyPlan: "Acknowledge the request, give bounded context, then ask one focused question.",
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
  rewritten: true,
  finalDraft: "I can share the key details. Which part would be most useful to start with?",
};

function messageResponse(value: unknown): Response {
  return new Response(JSON.stringify({
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    content: [
      { type: "thinking", thinking: "SYNTHETIC_HIDDEN_REASONING", signature: "synthetic-signature" },
      { type: "text", text: JSON.stringify(value) },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Claude Opus precision pipeline", () => {
  it("runs exactly one isolated analysis, writer, and reviewer call and returns only one final draft", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const request = vi.fn(async () => messageResponse(responses.shift()));

    await expect(runAnthropicDraftPipeline(CONTEXT, {
      apiKey: "[runtime-secret]",
      request,
    })).resolves.toEqual({
      draft: REVIEW.finalDraft,
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "stage-aware-single-draft-v1",
    });

    expect(request).toHaveBeenCalledTimes(3);
    const bodies = request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    for (const body of bodies) {
      expect(body.model).toBe("claude-opus-4-6");
      expect(body.thinking).toMatchObject({ type: "enabled", display: "omitted" });
      expect(body.output_config).toMatchObject({ effort: "high", format: { type: "json_schema" } });
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
    }
    expect(bodies[0].system).toContain("Never write reply prose");
    expect(bodies[0].messages[0].content).toContain("DIGEST: No pressure.");
    expect(bodies[1].messages[0].content).toContain("FULL-RULEBOOK: Never pressure the contact.");
    expect(bodies[1].messages[0].content).toContain("Use plain language and one useful question.");
    expect(bodies[2].messages[0].content).toContain(CANDIDATE.draft.text);
  });

  it("fails closed on a low-scoring review without returning reasoning or the rejected candidate", async () => {
    const lowReview = {
      ...REVIEW,
      scores: { ...REVIEW.scores, conversationGrounding: 14 },
      total: 89,
      finalDraft: "Generic response.",
    };
    const responses = [ANALYSIS, CANDIDATE, lowReview];
    const request = vi.fn(async () => messageResponse(responses.shift()));

    const error = await runAnthropicDraftPipeline(CONTEXT, {
      apiKey: "[runtime-secret]",
      request,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AnthropicPipelineError);
    expect(error.kind).toBe("quality");
    expect(error.message).not.toContain("Generic response");
    expect(error.message).not.toContain("SYNTHETIC_HIDDEN_REASONING");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("classifies provider failures without exposing provider response bodies", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "SYNTHETIC_PROVIDER_DETAIL" },
    }), { status: 529, headers: { "Content-Type": "application/json" } }));

    const error = await runAnthropicDraftPipeline(CONTEXT, {
      apiKey: "[runtime-secret]",
      request,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AnthropicPipelineError);
    expect(error.kind).toBe("provider_server");
    expect(error.message).not.toContain("SYNTHETIC_PROVIDER_DETAIL");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
