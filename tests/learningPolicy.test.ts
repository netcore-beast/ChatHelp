import { describe, expect, it } from "vitest";
import {
  digestableLearningRecord,
  findForbiddenIdentifier,
  goalCategoryForStage,
  roleIdForMessagingRole,
  sanitizeKnownIdentifiers,
  validateLearningRecord as validateLearningRecordWithKnown,
} from "../cloudflare/worker/src/learningPolicy";

const now = new Date("2026-08-09T12:00:00.000Z");
const validFeatures = {
  messageCountBucket: "medium",
  hasIncomingQuestion: true,
  hasNeedSignal: false,
  hasPermissionSignal: false,
  hasValueDiscussionSignal: false,
  hasNextStepSignal: false,
};
const known = { contactName: "", company: "", profileUrl: "", profileHandle: "" };
const validateLearningRecord = (input: Record<string, unknown>, at = now) => validateLearningRecordWithKnown(input, at, known);

function classifierRecord(overrides: Record<string, unknown> = {}) {
  return {
    recordKind: "classifier",
    roleId: "network_marketing",
    relationshipStage: "learn_interests",
    goalCategory: "discover_interests",
    provenance: "human_confirmed",
    classifierFeatures: validFeatures,
    ...overrides,
  };
}

describe("approved cloud learning policy", () => {
  it("maps only approved relationship stages and messaging roles", () => {
    expect(goalCategoryForStage("learn_interests")).toBe("discover_interests");
    expect(goalCategoryForStage("not-a-stage")).toBeNull();
    expect(roleIdForMessagingRole("Network Marketing")).toBe("network_marketing");
    expect(roleIdForMessagingRole("Unknown")).toBeNull();
  });

  it("rejects mismatched stages, unknown keys, and unbounded classifier features", () => {
    expect(() => validateLearningRecord(classifierRecord({ goalCategory: "present_value" }), now)).toThrow("goal_category_mismatch");
    expect(() => validateLearningRecord(classifierRecord({ unexpected: true }), now)).toThrow("unknown_key");
    expect(() => validateLearningRecord(classifierRecord({ classifierFeatures: { ...validFeatures, semanticTokens: ["private"] } }), now)).toThrow("invalid_classifier_features");
  });

  it("accepts only human-confirmed bounded classifier features", () => {
    expect(validateLearningRecord(classifierRecord(), now)).toEqual({
      ...classifierRecord(),
      schemaVersion: 1,
    });
    expect(() => validateLearningRecord(classifierRecord({ provenance: "provider_assisted" }), now)).toThrow("invalid_provenance");
  });

  it("accepts only enumerated human-confirmed evaluation actions", () => {
    expect(validateLearningRecord({
      recordKind: "evaluation",
      roleId: "job_seeker",
      relationshipStage: "identify_need",
      goalCategory: "identify_need",
      provenance: "human_confirmed",
      evaluationAction: "useful",
    }, now)).toMatchObject({ recordKind: "evaluation", evaluationAction: "useful", schemaVersion: 1 });
    expect(() => validateLearningRecordWithKnown({
      recordKind: "evaluation",
      roleId: "job_seeker",
      relationshipStage: "identify_need",
      goalCategory: "identify_need",
      provenance: "human_confirmed",
      evaluationAction: "provider_assisted",
    }, now)).toThrow("invalid_evaluation_action");
  });

  it("requires independent authorship and server-created attestations for generative records", () => {
    expect(() => validateLearningRecordWithKnown({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "provider_assisted",
      target: "A provider draft",
      rightsAttested: true,
      privacyAttested: true,
    }, now)).toThrow("invalid_provenance");

    expect(validateLearningRecord({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "What part of the work has been most interesting?",
      rightsAttested: true,
      privacyAttested: true,
    }, now)).toMatchObject({
      rightsAttestedAt: "2026-08-09T12:00:00.000Z",
      privacyAttestedAt: "2026-08-09T12:00:00.000Z",
    });
    expect(() => validateLearningRecord({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "A safe reply",
      rightsAttested: true,
      privacyAttested: true,
      rightsAttestedAt: "2020-01-01T00:00:00.000Z",
    }, now)).toThrow("unknown_key");
  });

  it("requires the Worker boundary to supply transient known identifiers for generative records", () => {
    expect(() => validateLearningRecordWithKnown({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "A safe independently authored reply",
      rightsAttested: true,
      privacyAttested: true,
    }, now)).toThrow("invalid_known_identifiers");
  });

  it("rejects direct identifiers after Unicode normalization", () => {
    const cases: Array<[string, string]> = [
      ["email_address", "person@example.com"],
      ["url", "Visit https://example.com/profile"],
      ["social_handle", "Message @person"],
      ["phone_number", "Call +1 (416) 555-0100"],
      ["postal_address", "Meet at 123 King Street"],
      ["long_identifier", "Reference 12345678"],
      ["control_character", "Hello\u0007 there"],
    ];
    for (const [reason, text] of cases) expect(findForbiddenIdentifier(text)).toBe(reason);
    expect(() => validateLearningRecord({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "Reach me at person@example.com",
      rightsAttested: true,
      privacyAttested: true,
    }, now)).toThrow("forbidden_identifier:email_address");
  });

  it("keeps exact retries digest-stable by omitting server attestation times", () => {
    const first = validateLearningRecord({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "What part of the work has been most interesting?",
      rightsAttested: true,
      privacyAttested: true,
    }, new Date("2026-08-09T12:00:00.000Z"));
    const retry = validateLearningRecord({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "What part of the work has been most interesting?",
      rightsAttested: true,
      privacyAttested: true,
    }, new Date("2026-08-09T12:05:00.000Z"));
    expect(digestableLearningRecord(first)).toEqual(digestableLearningRecord(retry));
    expect(digestableLearningRecord(first)).not.toHaveProperty("rightsAttestedAt");
    expect(digestableLearningRecord(first)).not.toHaveProperty("privacyAttestedAt");
  });

  it("sanitizes transient known values before validating and never persists them", () => {
    const record = validateLearningRecordWithKnown({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "Priya at Contoso has interesting work.",
      rightsAttested: true,
      privacyAttested: true,
    }, now, { contactName: "Priya", company: "Contoso", profileUrl: "", profileHandle: "" });
    expect(record.target).toBe("[contact] at [company] has interesting work.");
    expect(JSON.stringify(record)).not.toContain("Priya");
    expect(JSON.stringify(digestableLearningRecord(record))).not.toContain("Contoso");
    expect(sanitizeKnownIdentifiers("Priya at Contoso", { contactName: "Priya", company: "Contoso", profileUrl: "", profileHandle: "" })).toBe("[contact] at [company]");
    expect(() => validateLearningRecordWithKnown({
      recordKind: "generative",
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "A safe independently authored reply",
      rightsAttested: true,
      privacyAttested: true,
    }, now, { ...known, unexpected: "value" })).toThrow("invalid_known_identifiers");
  });

  it("refuses invalid persisted-looking records before building a digest", () => {
    expect(() => digestableLearningRecord({
      ...classifierRecord(),
      schemaVersion: 1,
      goalCategory: "present_value",
    })).toThrow("goal_category_mismatch");
    expect(() => digestableLearningRecord({
      recordKind: "generative",
      schemaVersion: 1,
      roleId: "socializing_networking",
      relationshipStage: "genuine_rapport",
      goalCategory: "build_rapport",
      provenance: "independently_user_authored",
      target: "person@example.com",
      rightsAttestedAt: "not-a-timestamp",
      privacyAttestedAt: "not-a-timestamp",
    })).toThrow();
  });
});
