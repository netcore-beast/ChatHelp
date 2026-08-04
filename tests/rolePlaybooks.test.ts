import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/lib/privateAi";
import { MESSAGING_ROLES, createEmptyWorkspace, resolveRoleGuidance } from "../src/lib/workspaceTypes";

describe("role-based messaging playbooks", () => {
  it("creates every supported role and resolves only the requested playbook", () => {
    const workspace = createEmptyWorkspace();
    expect(Object.keys(workspace.guidance.playbooks)).toEqual([...MESSAGING_ROLES]);
    workspace.guidance.playbooks["Human Resource"] = { objective: "HR-ONLY-GOAL", boundaries: "HR-ONLY-RULES" };
    workspace.guidance.playbooks["Network Marketing"] = { objective: "NETWORK-ONLY-GOAL", boundaries: "NETWORK-ONLY-RULES" };

    expect(resolveRoleGuidance(workspace.guidance, "Network Marketing")).toEqual({
      role: "Network Marketing",
      objective: "NETWORK-ONLY-GOAL",
      voice: workspace.guidance.voice,
      boundaries: "NETWORK-ONLY-RULES",
    });
  });

  it("puts one selected role into the three-draft prompt without mixing another role", () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.playbooks["Human Resource"] = { objective: "HR-ONLY-GOAL", boundaries: "HR-ONLY-RULES" };
    workspace.guidance.playbooks["Network Marketing"] = { objective: "NETWORK-ONLY-GOAL", boundaries: "NETWORK-ONLY-RULES" };
    const prompt = buildPrompt({
      contact: {
        id: "role-contact",
        name: "Taylor",
        headline: "Partner",
        profileNotes: "",
        platform: "linkedin",
        platformUrl: "",
        chat: [{ id: "incoming", role: "them", body: "What did you have in mind?", createdAt: "2026-08-04T00:00:00.000Z" }],
        documents: [],
        outcomes: [],
        retentionDays: 90,
      },
      guidance: resolveRoleGuidance(workspace.guidance, "Network Marketing"),
      latestQuestion: "Reply naturally.",
      retrievedContext: [],
      feedbackSummary: "",
      outcomeSummary: "",
    });

    expect(prompt).toContain("Role: Network Marketing");
    expect(prompt).toContain("Relationship goal: NETWORK-ONLY-GOAL");
    expect(prompt).toContain("Rules every reply must follow:\nNETWORK-ONLY-RULES");
    expect(prompt).not.toContain("HR-ONLY-GOAL");
    expect(prompt).not.toContain("HR-ONLY-RULES");
  });
});
