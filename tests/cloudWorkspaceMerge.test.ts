import { describe, expect, it } from "vitest";
import { deleteContactEverywhere, mergeCloudWorkspaces } from "../src/lib/cloudWorkspaceMerge";
import { createEmptyWorkspace, type Contact, type WorkspaceData } from "../src/lib/workspaceTypes";

function contact(overrides: Partial<Contact>): Contact {
  return {
    id: "contact-default", name: "Alex", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
    chat: [], documents: [], outcomes: [], retentionDays: 90, labels: [], pipelineStage: "inbox", notes: "", draftHistory: [],
    ...overrides,
  };
}

function workspace(contacts: Contact[]): WorkspaceData {
  return { ...createEmptyWorkspace(), contacts };
}

describe("encrypted workspace merge", () => {
  it("does not merge same-name contacts when their normalized profile URLs differ", async () => {
    const local = workspace([contact({ id: "local", name: "Alex Smith", profileUrl: "https://linkedin.com/in/alex-one" })]);
    const remote = workspace([contact({ id: "remote", name: "Alex Smith", profileUrl: "https://www.linkedin.com/in/alex-two/" })]);

    expect((await mergeCloudWorkspaces(local, remote)).contacts.map((item) => item.id)).toEqual(["local", "remote"]);
  });

  it("matches by profile before name and deduplicates stable IDs and fallback fingerprints", async () => {
    const local = workspace([contact({
      id: "local", name: "Old Display", profileUrl: "https://linkedin.com/in/same-person", labels: ["Local"], notes: "Keep local note",
      chat: [
        { id: "stable", role: "them", speaker: "Same Person", body: "Hello", createdAt: "2026-08-01T00:00:00.000Z" },
        { id: "local-fallback", role: "me", speaker: "You", body: "How are you?", createdAt: "2026-08-02T00:00:00.000Z" },
      ],
    })]);
    const remote = workspace([contact({
      id: "remote", name: "Current Display", profileUrl: "https://www.linkedin.com/in/same-person/", labels: ["Remote"], notes: "",
      chat: [
        { id: "stable", role: "them", speaker: "Same Person", body: "Hello", createdAt: "2026-08-01T00:00:00.000Z" },
        { id: "remote-fallback", role: "me", speaker: "You", body: "  How are you? ", createdAt: "2026-08-02T00:00:00.000Z" },
        { id: "new", role: "them", speaker: "Same Person", body: "Doing well", createdAt: "2026-08-03T00:00:00.000Z" },
      ],
    })]);

    const merged = await mergeCloudWorkspaces(local, remote);
    expect(merged.contacts).toHaveLength(1);
    expect(merged.contacts[0].chat.map((message) => message.id)).toEqual(["stable", "local-fallback", "new"]);
    expect(merged.contacts[0].labels).toEqual(["Local", "Remote"]);
    expect(merged.contacts[0].notes).toBe("Keep local note");
  });

  it("keeps ambiguous normalized-name contacts separate", async () => {
    const local = workspace([
      contact({ id: "local-1", name: "Taylor Lee" }),
      contact({ id: "local-2", name: " Taylor  Lee " }),
    ]);
    const remote = workspace([contact({ id: "remote", name: "TAYLOR LEE" })]);

    expect((await mergeCloudWorkspaces(local, remote)).contacts).toHaveLength(3);
  });

  it("preserves playbooks, feedback, outcomes, documents, and draft history", async () => {
    const local = workspace([contact({
      id: "local", profileUrl: "https://linkedin.com/in/merge", documents: [{ id: "local-doc", name: "Local", text: "local", createdAt: "2026-08-01T00:00:00.000Z" }],
      outcomes: [{ id: "local-outcome", result: "positive", note: "local", createdAt: "2026-08-01T00:00:00.000Z" }],
      draftHistory: [{ id: "local-draft", agenda: "local", drafts: ["One", "Two", "Three"], createdAt: "2026-08-01T00:00:00.000Z" }],
    })]);
    local.guidance.playbooks["Network Marketing"].boundaries = "LOCAL RULE";
    local.feedback = [{ id: "local-feedback", contactId: "local", draft: "draft", rating: "useful", note: "", createdAt: "2026-08-01T00:00:00.000Z" }];
    const remote = workspace([contact({
      id: "remote", profileUrl: "https://www.linkedin.com/in/merge/", documents: [{ id: "remote-doc", name: "Remote", text: "remote", createdAt: "2026-08-02T00:00:00.000Z" }],
      outcomes: [{ id: "remote-outcome", result: "neutral", note: "remote", createdAt: "2026-08-02T00:00:00.000Z" }],
      draftHistory: [{ id: "remote-draft", agenda: "remote", drafts: ["Four", "Five", "Six"], createdAt: "2026-08-02T00:00:00.000Z" }],
    })]);
    remote.feedback = [{ id: "remote-feedback", contactId: "remote", draft: "draft", rating: "not-useful", note: "", createdAt: "2026-08-02T00:00:00.000Z" }];

    const merged = await mergeCloudWorkspaces(local, remote);
    expect(merged.contacts[0].documents.map((item) => item.id)).toEqual(["local-doc", "remote-doc"]);
    expect(merged.contacts[0].outcomes.map((item) => item.id)).toEqual(["local-outcome", "remote-outcome"]);
    expect(merged.contacts[0].draftHistory?.map((item) => item.id)).toEqual(["local-draft", "remote-draft"]);
    expect(merged.feedback.map((item) => item.id)).toEqual(["local-feedback", "remote-feedback"]);
    expect(merged.guidance.playbooks["Network Marketing"].boundaries).toBe("LOCAL RULE");
  });

  it("uses encrypted identity tombstones to prevent resurrection on another device", async () => {
    const original = workspace([contact({ id: "device-a", name: "Deleted Person", profileUrl: "https://linkedin.com/in/deleted-person" })]);
    const deleted = await deleteContactEverywhere(original, "device-a", "2026-08-05T00:00:00.000Z");
    const otherDevice = workspace([contact({ id: "device-b", name: "Deleted Person", profileUrl: "https://www.linkedin.com/in/deleted-person/" })]);

    expect(deleted.contacts).toEqual([]);
    expect(deleted.deletionTombstones).toHaveLength(1);
    expect(deleted.deletionTombstones[0].contactId).toBe("device-a");
    expect(deleted.deletionTombstones[0].identityHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
    expect(JSON.stringify(deleted.deletionTombstones)).not.toContain("Deleted Person");
    expect(JSON.stringify(deleted.deletionTombstones)).not.toContain("deleted-person");
    expect((await mergeCloudWorkspaces(deleted, otherDevice)).contacts).toEqual([]);
  });
});
