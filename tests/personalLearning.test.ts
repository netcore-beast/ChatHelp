import { describe, expect, it } from "vitest";
import {
  isGenerativeTrainingEligible,
  normalizeFeedback,
  selectLearningExamples,
} from "../src/lib/personalLearning";
import { createEmptyWorkspace } from "../src/lib/workspaceTypes";

function learningRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "feedback-a",
    contactId: "contact-a",
    role: "Network Marketing",
    relationshipStage: "learn_interests",
    conversationGoal: "Learn which professional challenge matters most",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    action: "edited",
    draft: "Provider-assisted starting point",
    preferredResponse: "What kind of challenge has been taking most of your attention lately?",
    outcome: "helpful conversation",
    reason: "Warm and specific",
    origin: "independently_user_authored",
    independentlyAuthoredAttested: true,
    eligibleForRetrieval: true,
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("encrypted personal learning", () => {
  it("defaults learning off and migrates legacy ratings without retrieval eligibility", () => {
    expect(createEmptyWorkspace().personalLearning.enabled).toBe(false);

    const accepted = normalizeFeedback({
      id: "legacy-useful",
      contactId: "contact-a",
      draft: "Legacy provider draft",
      rating: "useful",
      note: "Worked well",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const rejected = normalizeFeedback({
      id: "legacy-not-useful",
      contactId: "contact-a",
      draft: "Legacy rejected draft",
      rating: "not-useful",
      note: "Too generic",
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(accepted).toMatchObject({ action: "accepted", origin: "provider_assisted", eligibleForRetrieval: false, enabled: true });
    expect(rejected).toMatchObject({ action: "rejected", origin: "provider_assisted", eligibleForRetrieval: false, enabled: true });
    expect(normalizeFeedback({ id: "broken", eligibleForRetrieval: true })).toBeNull();
  });

  it("retrieves at most three explicitly approved examples with deterministic role/stage ranking", () => {
    const records = [
      learningRecord({ id: "later-id", preferredResponse: "SECOND-TIE", updatedAt: "2026-08-03T00:00:00.000Z" }),
      learningRecord({ id: "earlier-id", preferredResponse: "FIRST-TIE", updatedAt: "2026-08-03T00:00:00.000Z" }),
      learningRecord({ id: "newer", preferredResponse: "NEWEST", updatedAt: "2026-08-04T00:00:00.000Z" }),
      learningRecord({ id: "fourth", preferredResponse: "FOURTH", updatedAt: "2026-08-02T00:00:00.000Z" }),
      learningRecord({ id: "wrong-stage", relationshipStage: "introduce_value", preferredResponse: "WRONG-STAGE" }),
      learningRecord({ id: "disabled", enabled: false, preferredResponse: "DISABLED" }),
      learningRecord({ id: "unapproved", eligibleForRetrieval: false, preferredResponse: "UNAPPROVED" }),
      learningRecord({ id: "provider-assisted", origin: "provider_assisted", preferredResponse: "PROVIDER" }),
    ];

    const selected = selectLearningExamples(records, {
      currentContactId: "current-contact",
      role: "Network Marketing",
      relationshipStage: "learn_interests",
      conversationGoal: "Learn which professional challenge needs attention",
    }, 20);

    expect(selected).toHaveLength(3);
    expect(selected.map((item) => item.preferredResponse)).toEqual(["NEWEST", "FIRST-TIE", "SECOND-TIE"]);
    expect(JSON.stringify(selected)).not.toContain("contact-a");
    expect(JSON.stringify(selected)).not.toContain("Provider-assisted starting point");
  });

  it("exposes only bounded tone/structure examples and never cross-contact private facts", () => {
    const record = learningRecord({
      contactId: "other-contact",
      draft: "PRIVATE MESSAGE QUOTE from Pat at Secret Company https://example.invalid",
      reason: "Pat's private compensation fact",
      conversationGoal: "Understand general career priorities",
    });

    const [example] = selectLearningExamples([record], {
      currentContactId: "current-contact",
      role: "Network Marketing",
      relationshipStage: "learn_interests",
      conversationGoal: "Understand career priorities",
    });

    expect(example).toEqual({
      role: "Network Marketing",
      relationshipStage: "learn_interests",
      conversationGoal: "Understand general career priorities",
      preferredResponse: "What kind of challenge has been taking most of your attention lately?",
    });
    expect(JSON.stringify(example)).not.toMatch(/Pat|Secret Company|example\.invalid|compensation/i);
  });

  it("rejects provider-assisted, disabled, unattested, and unapproved generative targets", () => {
    expect(isGenerativeTrainingEligible(learningRecord())).toBe(true);
    expect(isGenerativeTrainingEligible(learningRecord({ origin: "provider_assisted" }))).toBe(false);
    expect(isGenerativeTrainingEligible(learningRecord({ independentlyAuthoredAttested: false }))).toBe(false);
    expect(isGenerativeTrainingEligible(learningRecord({ eligibleForRetrieval: false }))).toBe(false);
    expect(isGenerativeTrainingEligible(learningRecord({ enabled: false }))).toBe(false);
  });
});
