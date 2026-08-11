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
    criticalFailures: [],
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
    })).toBe(false);
  });

  it("allows an early introduction only for a model-identified request verified by the current contact message", () => {
    const analysis = {
      explicitRequest: true,
      needEstablished: false,
      permissionGranted: false,
    };

    expect(canIntroduceValue("genuine_rapport", analysis, {
      sender: "CONTACT",
      text: "Could you tell me more about your business opportunity?",
    })).toBe(true);
    expect(canIntroduceValue("genuine_rapport", analysis, {
      sender: "CONTACT",
      text: "I do not understand how your product works. Can you explain?",
    })).toBe(true);
    expect(canIntroduceValue("genuine_rapport", analysis, {
      sender: "USER",
      text: "Could you tell me more about your business opportunity?",
    })).toBe(false);
    expect(canIntroduceValue("genuine_rapport", analysis, {
      sender: "CONTACT",
      text: "I'm not interested in side-income opportunities.",
    })).toBe(false);
    expect(canIntroduceValue("genuine_rapport", analysis, {
      sender: "CONTACT",
      text: "Do you use Microsoft Sentinel in your work?",
    })).toBe(false);
    expect(canIntroduceValue("genuine_rapport", analysis, {
      sender: "CONTACT",
      text: "Can you explain how a business should secure Microsoft Sentinel?",
    })).toBe(false);
    expect(canIntroduceValue("genuine_rapport", {
      ...analysis,
      explicitRequest: false,
    }, {
      sender: "CONTACT",
      text: "Please share the details of your side-income program.",
    })).toBe(false);
  });

  it("computes server-owned stage fields instead of trusting model output", () => {
    const parsed = parseDraftAnalysis({
      observedStage: "introduce_value",
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
    }, "learn_interests");

    expect(parsed.storedStage).toBe("learn_interests");
    expect(parsed.effectiveStage).toBe("identify_need");
    expect(parsed.nextAllowedStage).toBe("identify_need");
    expect(() => parseDraftAnalysis({ ...parsed, finalDraft: "Hidden reply prose" })).toThrow(/analysis/i);
  });

  it("computes the rubric total on the server and requires every exact weighted dimension", () => {
    expect(validateFinalReview(review({
      scores: { ...PASSING_SCORES, conversationGrounding: 14 },
    }), { canIntroduceValue: false, conversationText: "" })).toEqual({ ok: false, reason: "rubric" });

    expect(validateFinalReview(review({
      scores: { ...PASSING_SCORES, humanTone: 9 },
    }), { canIntroduceValue: false, conversationText: "" })).toEqual({
      ok: true,
      draft: "That makes sense. Which part of the role would be most useful to explore first?",
    });
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

  it.each([
    "I can share how our side-income program works if that would be useful.",
    "I have a business idea that could be a good fit for your goals.",
    "Our DialogMint service could help you connect with more people.",
    "I can show you Acme Growth if you would like.",
    "I can share DialogMint Pro when you are ready.",
    "I can recommend Acme Growth Platform for building your network.",
    "I help professionals create another income stream through a flexible community. Want me to explain how it works?",
  ])("blocks contextual offering language at an early stage: %s", (finalDraft) => {
    expect(validateFinalReview(review({ finalDraft }), {
      canIntroduceValue: false,
      conversationText: "",
    })).toEqual({ ok: false, reason: "premature_pitch" });
  });

  it.each([
    "Microsoft Sentinel is one SIEM option. Which capabilities are you comparing?",
    "That sounds like a useful product-design challenge. What are you optimizing?",
    "Your business idea sounds thoughtful. What led you to it?",
  ])("does not mistake ordinary technical or contact-led discussion for a pitch: %s", (finalDraft) => {
    expect(validateFinalReview(review({ finalDraft }), {
      canIntroduceValue: false,
      conversationText: "",
    })).toEqual({ ok: true, draft: finalDraft });
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
