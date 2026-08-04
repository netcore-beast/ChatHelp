import { describe, expect, it } from "vitest";
import {
  PLAYBOOK_BACKUP_MAX_BYTES,
  parsePlaybookBackup,
  serializePlaybookBackup,
} from "../src/lib/playbookTransfer";
import { PLAYBOOK_RULES_MAX_CHARS, createEmptyWorkspace } from "../src/lib/workspaceTypes";

describe("messaging playbook settings transfer", () => {
  it("round-trips all role settings without exporting contacts, conversations, or cloud configuration", () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.selectedRole = "Network Marketing";
    workspace.inboxRole = "Job Seeker";
    workspace.guidance.voice = "Warm and specific";
    workspace.guidance.playbooks["Network Marketing"] = {
      objective: "Build trust before discussing an opportunity",
      boundaries: "Ask one question and never pressure the person.",
    };
    workspace.contacts.push({
      id: "excluded-contact",
      name: "Private Person",
      headline: "",
      profileNotes: "EXCLUDED-CONVERSATION-DATA",
      platform: "linkedin",
      platformUrl: "",
      chat: [],
      documents: [],
      outcomes: [],
      retentionDays: 90,
    });
    workspace.cloudInference.accessToken = "EXCLUDED-ACCESS-VALUE";

    const serialized = serializePlaybookBackup(workspace.guidance, workspace.inboxRole, "2026-08-04T12:00:00.000Z");
    expect(serialized).not.toContain("Private Person");
    expect(serialized).not.toContain("EXCLUDED-CONVERSATION-DATA");
    expect(serialized).not.toContain("EXCLUDED-ACCESS-VALUE");

    const restored = parsePlaybookBackup(serialized);
    expect(restored.guidance).toEqual(workspace.guidance);
    expect(restored.inboxRole).toBe("Job Seeker");
  });

  it("preserves reply rules beyond the previous 20,000-character limit", () => {
    const workspace = createEmptyWorkspace();
    const tailMarker = "FINAL-LONG-RULE-MARKER";
    workspace.guidance.playbooks["Human Resource"].boundaries = "R".repeat(30_000) + tailMarker;

    const restored = parsePlaybookBackup(serializePlaybookBackup(workspace.guidance, workspace.inboxRole));
    expect(restored.guidance.playbooks["Human Resource"].boundaries).toHaveLength(30_000 + tailMarker.length);
    expect(restored.guidance.playbooks["Human Resource"].boundaries).toContain(tailMarker);
    expect(restored.guidance.playbooks["Human Resource"].boundaries.length).toBeLessThanOrEqual(PLAYBOOK_RULES_MAX_CHARS);
  });

  it("rejects unsupported and oversized files", () => {
    expect(() => parsePlaybookBackup("{}"))
      .toThrow(/not a supported ChatHelp messaging-playbook backup/);
    expect(() => parsePlaybookBackup("x".repeat(PLAYBOOK_BACKUP_MAX_BYTES + 1)))
      .toThrow(/512 KB or smaller/);
  });
});
