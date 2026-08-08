import { describe, expect, it, vi } from "vitest";
import {
  GPT_REVIEW_MODEL,
  LLAMA_CANDIDATE_MODEL,
  WORKERS_AI_MODEL,
  WorkersAiPipelineError,
  runWorkersAiDraftPipeline,
} from "../cloudflare/worker/src/workersAiDraftPipeline.js";

const CONTEXT = {
  conversationContext: "<conversation_context>\n{\"recentMessages\":[{\"sender\":\"CONTACT\",\"text\":\"What kind of work do you do?\"}]}\n</conversation_context>",
  latestMeaningfulIncoming: { id: "m1", sender: "CONTACT", speaker: "Alex", text: "What kind of work do you do?", timestamp: "2026-01-01T00:00:00.000Z" },
  playbook: {
    role: "Network Marketing",
    relationshipGoal: "Build genuine trust before discussing business",
    voice: "Warm and natural",
    rulebookFull: "FULL-RULEBOOK: Do not pitch before need and permission.",
    rulebookDigest: "DIGEST: Learn before recommending.",
  },
  personalGuidelines: "Never sound scripted.",
  conversationGoal: "Understand Alex's interests.",
  relationshipStage: "genuine_rapport",
  knownFacts: [],
  unansweredQuestions: ["What work is most meaningful to Alex?"],
  learningExamples: [],
  replyObjective: "Answer naturally and keep learning about Alex.",
};

const ANALYSIS = {
  storedStage: "genuine_rapport",
  observedStage: "learn_interests",
  effectiveStage: "learn_interests",
  nextAllowedStage: "learn_interests",
  latestIncomingIntent: "The contact asked about the user's work.",
  knownFacts: [],
  unansweredQuestions: ["What work is most meaningful to the contact?"],
  goalForThisReply: "Answer without pitching and learn one interest.",
  toneDirectives: ["Natural", "Warm"],
  prohibitedMoves: ["Do not pitch"],
  replyPlan: "Answer at a high level, then ask one genuine question.",
  evidence: ["m1"],
  needEstablished: false,
  permissionGranted: false,
  explicitRequest: false,
};

const CANDIDATE = {
  draft: {
    text: "I work around technology and relationship-based business. What kind of work do you find most rewarding?",
    stage: "learn_interests",
    goal: "Answer without pitching and learn one interest.",
  },
};

const REVIEW = {
  scores: {
    conversationGrounding: 24,
    latestMessageRelevance: 20,
    personalGuidelineCompliance: 15,
    goalStageAlignment: 15,
    humanTone: 10,
    curiosityNeedDiscovery: 5,
    technicalFactualAccuracy: 5,
    ethicalSellingBoundaries: 5,
  },
  total: 99,
  criticalFailures: [],
  rewritten: false,
  finalDraft: CANDIDATE.draft.text,
};

describe("permanent Workers AI fallback", () => {
  it("uses Llama for analysis and GPT-OSS for one draft plus independent review", async () => {
    const responses = [ANALYSIS, CANDIDATE, REVIEW];
    const ai = { run: vi.fn(async () => ({ response: responses.shift() })) };
    const stages: Array<[string, string]> = [];

    await expect(runWorkersAiDraftPipeline(CONTEXT, {
      ai,
      emit: (_event: string, data: { stage: string; status: string }) => stages.push([data.stage, data.status]),
    })).resolves.toEqual({
      draft: REVIEW.finalDraft,
      provider: "cloudflare",
      model: WORKERS_AI_MODEL,
      mode: "stage-aware-single-draft-v1",
    });

    expect(ai.run.mock.calls.map(([model]) => model)).toEqual([
      LLAMA_CANDIDATE_MODEL,
      GPT_REVIEW_MODEL,
      GPT_REVIEW_MODEL,
    ]);
    expect(stages).toEqual([
      ["analyzing", "in-progress"], ["analyzing", "done"],
      ["drafting", "in-progress"], ["drafting", "done"],
      ["reviewing", "in-progress"], ["reviewing", "done"],
    ]);
    const planner = ai.run.mock.calls[0][1];
    const writer = ai.run.mock.calls[1][1];
    const reviewer = ai.run.mock.calls[2][1];
    expect(planner.messages[0].content).toContain("DIGEST: Learn before recommending.");
    expect(planner.messages[0].content).not.toContain("FULL-RULEBOOK");
    expect(writer.messages[0].content).toContain("FULL-RULEBOOK: Do not pitch before need and permission.");
    expect(reviewer.messages[0].content).toContain("FULL-RULEBOOK: Do not pitch before need and permission.");
    expect(reviewer.messages[1].content).toContain(CANDIDATE.draft.text);
  });

  it("retries a stage once without response_format when structured parsing fails", async () => {
    const ai = { run: vi.fn()
      .mockResolvedValueOnce({ response: "not-json" })
      .mockResolvedValueOnce({ response: ANALYSIS })
      .mockResolvedValueOnce({ response: CANDIDATE })
      .mockResolvedValueOnce({ response: REVIEW }) };

    await expect(runWorkersAiDraftPipeline(CONTEXT, { ai })).resolves.toMatchObject({ draft: REVIEW.finalDraft });
    expect(ai.run).toHaveBeenCalledTimes(4);
    expect(ai.run.mock.calls[0][1].response_format.type).toBe("json_schema");
    expect(ai.run.mock.calls[1][1].response_format).toBeUndefined();
  });

  it("uses the same rubric and premature-pitch policy as the Claude path", async () => {
    const policyFailure = {
      ...REVIEW,
      finalDraft: "My business opportunity could be the perfect product for you.",
    };
    const responses = [ANALYSIS, CANDIDATE, policyFailure];
    const ai = { run: vi.fn(async () => ({ response: responses.shift() })) };

    const error = await runWorkersAiDraftPipeline(CONTEXT, { ai }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WorkersAiPipelineError);
    expect(error.kind).toBe("policy");
    expect(error.message).not.toContain("business opportunity");
  });
});
