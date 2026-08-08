import { describe, expect, it } from "vitest";
import {
  canIntroduceValue,
  effectiveStage,
  parseDraftAnalysis,
  validateFinalReview,
} from "../cloudflare/worker/src/draftPolicy.js";

const PASSING_SCORES = {
  conversationGrounding: 25,
  latestMessageRelevance: 20,
  personalGuidelineCompliance: 15,
  goalStageAlignment: 15,
  humanTone: 10,
  curiosityNeedDiscovery: 5,
  technicalFactualAccuracy: 5,
  ethicalSellingBoundaries: 5,
};

function review(overrides: Record<string, unknown> = {}) {
  return {
    scores: PASSING_SCORES,
    total: 100,
    criticalFailures: [],
    rewritten: false,
    finalDraft: "That makes sense. Which part of the role would be most useful to explore first?",
    ...overrides,
  };
}

describe("stage-aware draft policy", () => {
  it("allows an observed stage to advance at most one step beyond the stored stage", () => {
    expect(effectiveStage("new_connection", "introduce_value", ["The contact discussed their work."]))
      .toBe("genuine_rapport");
    expect(effectiveStage("identify_need", "learn_interests", ["The need is still unclear."]))
      .toBe("learn_interests");
    expect(effectiveStage("not-a-stage", "introduce_value", [])).toBe("new_connection");
  });

  it("blocks a product or business introduction until need and permission exist", () => {
    expect(canIntroduceValue("learn_interests", {
      explicitRequest: false,
      needEstablished: false,
      permissionGranted: false,
    })).toBe(false);
    expect(canIntroduceValue("introduce_value", {
      explicitRequest: false,
      needEstablished: true,
      permissionGranted: true,
    })).toBe(true);
    expect(canIntroduceValue("genuine_rapport", {
      explicitRequest: true,
      needEstablished: false,
      permissionGranted: false,
    })).toBe(true);
  });

  it("parses bounded analysis without accepting reply prose or invalid stage jumps", () => {
    const parsed = parseDraftAnalysis({
      storedStage: "learn_interests",
      observedStage: "introduce_value",
      effectiveStage: "identify_need",
      nextAllowedStage: "identify_need",
      latestIncomingIntent: "The contact wants role details.",
      knownFacts: ["The contact asked for role details."],
      unansweredQuestions: ["Which detail matters most?"],
      goalForThisReply: "Clarify the contact's priority.",
      toneDirectives: ["Warm", "Concise"],
      prohibitedMoves: ["Do not pitch"],
      replyPlan: "Answer briefly, then ask one useful question.",
      evidence: ["m1"],
      needEstablished: false,
      permissionGranted: false,
      explicitRequest: false,
    });

    expect(parsed.effectiveStage).toBe("identify_need");
    expect(() => parseDraftAnalysis({ ...parsed, finalDraft: "Hidden reply prose" })).toThrow(/analysis/i);
    expect(() => parseDraftAnalysis({ ...parsed, effectiveStage: "introduce_value" })).toThrow(/stage/i);
  });

  it("requires a truthful 90-point total and every exact weighted dimension", () => {
    expect(validateFinalReview(review({
      scores: { ...PASSING_SCORES, conversationGrounding: 14 },
      total: 89,
    }), { canIntroduceValue: false, conversationText: "" })).toEqual({ ok: false, reason: "rubric" });

    expect(validateFinalReview(review({
      scores: { ...PASSING_SCORES, humanTone: 9 },
      total: 100,
    }), { canIntroduceValue: false, conversationText: "" })).toEqual({ ok: false, reason: "total" });
  });

  it("fails critical, copied, invented-history, and premature-pitch output regardless of score", () => {
    expect(validateFinalReview(review({ criticalFailures: ["premature_pitch"] }), {
      canIntroduceValue: true,
      conversationText: "",
    })).toEqual({ ok: false, reason: "critical" });

    const copied = "The migration deadline is Friday and the team needs a clear plan.";
    expect(validateFinalReview(review({ finalDraft: copied }), {
      canIntroduceValue: false,
      conversationText: `CONTACT: ${copied}`,
    })).toEqual({ ok: false, reason: "copied" });

    expect(validateFinalReview(review({
      finalDraft: "Honestly, I got into zero trust after seeing perimeter defenses bypassed.",
    }), { canIntroduceValue: false, conversationText: "" })).toEqual({ ok: false, reason: "unsupported_history" });

    expect(validateFinalReview(review({
      finalDraft: "My business opportunity could be the perfect product for you.",
    }), { canIntroduceValue: false, conversationText: "" })).toEqual({ ok: false, reason: "premature_pitch" });
  });

  it("returns exactly one validated paste-ready final draft", () => {
    expect(validateFinalReview(review(), {
      canIntroduceValue: false,
      conversationText: "CONTACT: Could you share the role details?",
    })).toEqual({
      ok: true,
      draft: "That makes sense. Which part of the role would be most useful to explore first?",
    });
  });
});
