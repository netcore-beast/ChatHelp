import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_STAGES,
  nextRelationshipStage,
  normalizePersonalGuidelines,
} from "../src/lib/workspaceTypes";

describe("relationship stages", () => {
  it("keeps the approved eight-stage order for one-step progression", () => {
    expect(RELATIONSHIP_STAGES).toEqual([
      "new_connection",
      "genuine_rapport",
      "learn_interests",
      "identify_need",
      "ask_permission",
      "introduce_value",
      "answer_without_pressure",
      "voluntary_next_step",
    ]);
    expect(nextRelationshipStage("new_connection")).toBe("genuine_rapport");
    expect(nextRelationshipStage("voluntary_next_step")).toBe("voluntary_next_step");
  });

  it("normalizes personal guidelines before limiting them to 2,000 Unicode characters", () => {
    const normalized = normalizePersonalGuidelines("e\u0301".repeat(2_100));

    expect(Array.from(normalized)).toHaveLength(2_000);
    expect(normalized.startsWith("ééé")).toBe(true);
    expect(normalizePersonalGuidelines("  Keep it warm.  ")).toBe("Keep it warm.");
  });
});
