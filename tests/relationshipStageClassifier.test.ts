import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateStageClassifier,
  predictRelationshipStage,
  trainStageClassifier,
  type RelationshipStageFeatureRecord,
} from "../src/lib/relationshipStageClassifier";
import { RELATIONSHIP_STAGES, type RelationshipStage } from "../src/lib/workspaceTypes";

function record(
  id: string,
  confirmedStage: RelationshipStage,
  semanticToken: string,
  humanConfirmed = true,
): RelationshipStageFeatureRecord {
  return {
    id,
    featureSchemaVersion: 1,
    role: "Network Marketing",
    messageCountBucket: "medium",
    hasIncomingQuestion: true,
    hasNeedSignal: confirmedStage === "identify_need",
    hasPermissionSignal: confirmedStage === "ask_permission",
    hasValueDiscussionSignal: confirmedStage === "introduce_value" || confirmedStage === "answer_without_pressure",
    hasNextStepSignal: confirmedStage === "voluntary_next_step",
    semanticTokens: [semanticToken],
    confirmedStage,
    humanConfirmed,
    createdAt: `2026-08-01T00:00:${id.padStart(2, "0")}Z`,
  };
}

describe("local relationship stage classifier", () => {
  it("trains deterministically across all eight ordered labels using human confirmations only", () => {
    const records = RELATIONSHIP_STAGES.flatMap((stage, index) => [
      record(String(index * 2), stage, `signal_${stage}`),
      record(String(index * 2 + 1), stage, `signal_${stage}`),
    ]);
    records.push(record("99", "introduce_value", "signal_learn_interests", false));

    const first = trainStageClassifier(records);
    const second = trainStageClassifier([...records].reverse());

    expect(first).toEqual(second);
    expect(first.labels).toEqual(RELATIONSHIP_STAGES);
    expect(first.trainingRecordCount).toBe(16);
    expect(first.labelDocumentCounts).toEqual(Object.fromEntries(RELATIONSHIP_STAGES.map((stage) => [stage, 2])));
    expect(JSON.stringify(first)).not.toContain("99");
  });

  it("predicts a learned stage but preserves the manual stage below the confidence threshold", () => {
    const model = trainStageClassifier([
      record("1", "learn_interests", "career_priorities"),
      record("2", "learn_interests", "career_priorities"),
      record("3", "learn_interests", "career_priorities"),
      record("4", "introduce_value", "product_value"),
    ]);
    const strong = predictRelationshipStage(model, {
      featureSchemaVersion: 1,
      role: "Network Marketing",
      messageCountBucket: "medium",
      hasIncomingQuestion: true,
      hasNeedSignal: false,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: ["career_priorities"],
    }, "new_connection", 0.30);
    expect(strong).toMatchObject({ stage: "learn_interests", suggestedStage: "learn_interests", usedFallback: false });

    const cautious = predictRelationshipStage(model, {
      featureSchemaVersion: 1,
      role: "Network Marketing",
      messageCountBucket: "unknown",
      hasIncomingQuestion: false,
      hasNeedSignal: false,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: [],
    }, "new_connection", 0.99);
    expect(cautious.stage).toBe("new_connection");
    expect(cautious.usedFallback).toBe(true);
  });

  it("evaluates deterministically without raw conversations or generated text", () => {
    const records = RELATIONSHIP_STAGES.flatMap((stage, index) => [
      record(String(index * 2), stage, `stage_${stage}`),
      record(String(index * 2 + 1), stage, `stage_${stage}`),
    ]);
    const evaluation = evaluateStageClassifier(records);
    expect(evaluation.evaluatedRecords).toBe(16);
    expect(evaluation.accuracy).toBeGreaterThanOrEqual(0.9);
    expect(Object.keys(evaluation.byStage)).toEqual(RELATIONSHIP_STAGES);

    const source = readFileSync("src/lib/relationshipStageClassifier.ts", "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/generatePrivate|WebLLM|Workers AI|conversationContext|preferredResponse/);
  });
});
