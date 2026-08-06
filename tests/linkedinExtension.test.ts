import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_EXTENSION_SOURCE,
  isActivelySnoozed,
  isCurrentLinkedInExtensionVersion,
  isLikelyMobileDevice,
  isReminderDue,
  parseLinkedInExtensionStatus,
  parseLinkedInExtensionSnapshot,
  parseLinkedInSyncState,
  recommendLinkedInCaptureMethod,
  upsertLinkedInSnapshot,
  type LinkedInExtensionSnapshot,
} from "../src/lib/linkedinExtension";
import type { Contact } from "../src/lib/workspaceTypes";

const rawSnapshot = {
  source: LINKEDIN_EXTENSION_SOURCE,
  version: 2,
  captureMode: "automatic",
  captureId: "capture-1",
  capturedAt: "2026-08-02T12:00:00.000Z",
  pageUrl: "https://www.linkedin.com/messaging/thread/abc/?tracking=remove-me",
  contact: {
    name: "Alex Morgan",
    headline: "VP Partnerships at Example Co",
    company: "Example Co",
    profileUrl: "https://linkedin.com/in/alex-morgan/?trk=remove",
    avatarUrl: "https://media.licdn.com/dms/image/example?version=1",
  },
  messages: [
    { id: "event-1", sourceId: "urn:li:msg:1", role: "them", speaker: "Alex Morgan", body: "Thanks for connecting.", createdAt: "2026-08-02T11:58:00.000Z", attachments: [] },
    { id: "event-2", sourceId: "urn:li:msg:2", role: "me", speaker: "You", body: "What are you working on now?", createdAt: "2026-08-02T11:59:00.000Z", attachments: [{ id: "attachment-1", label: "Roadmap preview", kind: "image" }] },
  ],
};

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-alex",
    name: "Alex Morgan",
    headline: "",
    company: "",
    profileNotes: "",
    platform: "linkedin",
    platformUrl: "",
    chat: [],
    documents: [],
    outcomes: [],
    retentionDays: 90,
    profileUrl: "https://www.linkedin.com/in/alex-morgan/",
    avatarUrl: "",
    conversationUrl: "",
    source: "manual",
    labels: [],
    pipelineStage: "inbox",
    notes: "",
    snoozedUntil: "",
    followUpAt: "",
    archivedAt: "",
    firstSyncedAt: "",
    lastSyncedAt: "",
    lastSyncMessageCount: 0,
    draftHistory: [],
    ...overrides,
  };
}

describe("automatic LinkedIn extension import", () => {
  it("selects desktop extension capture while keeping mobile manual", () => {
    expect(recommendLinkedInCaptureMethod({ detected: false, extensionConnected: false, isMobile: false, supportsScreenCapture: true })).toBe("detecting");
    expect(recommendLinkedInCaptureMethod({ detected: true, extensionConnected: true, isMobile: false, supportsScreenCapture: true })).toBe("extension");
    expect(recommendLinkedInCaptureMethod({ detected: true, extensionConnected: true, isMobile: true, supportsScreenCapture: true })).toBe("manual");
    expect(isLikelyMobileDevice("Mozilla/5.0 (Linux; Android 16; Mobile)")).toBe(true);
    expect(isLikelyMobileDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });

  it("validates and sanitizes a versioned app-bound snapshot", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.captureMode).toBe("automatic");
    expect(snapshot?.pageUrl).toBe("https://www.linkedin.com/messaging/thread/abc/");
    expect(snapshot?.contact.profileUrl).toBe("https://www.linkedin.com/in/alex-morgan/");
    expect(snapshot?.contact.avatarUrl).toBe("https://media.licdn.com/dms/image/example");
    expect(snapshot?.messages[0].sourceId).toBe("urn:li:msg:1");
  });

  it("validates extension versions, status, and visible sync state", () => {
    expect(isCurrentLinkedInExtensionVersion("0.5.0")).toBe(true);
    expect(isCurrentLinkedInExtensionVersion("0.4.0")).toBe(false);
    expect(isCurrentLinkedInExtensionVersion("0.3.9")).toBe(false);
    expect(parseLinkedInExtensionStatus({
      source: LINKEDIN_EXTENSION_SOURCE,
      version: 2,
      statusId: "status-1",
      occurredAt: "2026-08-02T12:00:00.000Z",
      kind: "info",
      code: "reading_visible_conversation",
      message: "Reading visible conversation.",
      observedContact: null,
    })?.code).toBe("reading_visible_conversation");
    expect(parseLinkedInSyncState({
      source: LINKEDIN_EXTENSION_SOURCE,
      version: 1,
      stateId: "state-1",
      occurredAt: "2026-08-02T12:00:00.000Z",
      enabled: true,
      paused: false,
      permissionGranted: true,
      code: "waiting_for_conversation",
      message: "Waiting.",
      lastContactName: "",
      lastMessageCount: 0,
    })).toMatchObject({ enabled: true, paused: false, permissionGranted: true });
  });

  it("automatically creates an unknown local contact and updates it without duplication", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const first = upsertLinkedInSnapshot([], snapshot);
    expect(first.action).toBe("created");
    expect(first.contacts).toHaveLength(1);
    expect(first.contacts[0]).toMatchObject({
      name: "Alex Morgan",
      company: "Example Co",
      source: "linkedin-extension",
      profileUrl: "https://www.linkedin.com/in/alex-morgan/",
      conversationUrl: "https://www.linkedin.com/messaging/thread/abc/",
    });
    expect(first.contacts[0].chat).toHaveLength(2);

    const preserved = { ...first.contacts[0], labels: ["warm lead"], notes: "Send the case study", pipelineStage: "warm" as const, followUpAt: "2026-08-10T12:00:00.000Z" };
    const second = upsertLinkedInSnapshot([preserved], { ...snapshot, captureId: "capture-2", capturedAt: "2026-08-02T12:05:00.000Z" });
    expect(second.action).toBe("no-change");
    expect(second.contacts).toHaveLength(1);
    expect(second.contacts[0].chat).toHaveLength(2);
    expect(second.contacts[0]).toMatchObject({ labels: ["warm lead"], notes: "Send the case study", pipelineStage: "warm", followUpAt: "2026-08-10T12:00:00.000Z" });
  });

  it("gives profile URL matching precedence over a same-name contact", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const profileMatch = contact({ id: "profile-match", name: "Different local label" });
    const nameMatch = contact({ id: "name-match", profileUrl: "https://www.linkedin.com/in/someone-else/" });
    const result = upsertLinkedInSnapshot([nameMatch, profileMatch], snapshot);
    expect(result.contactId).toBe("profile-match");
    expect(result.matchedBy).toBe("profile");
    expect(result.contacts.find((item) => item.id === "name-match")?.chat).toHaveLength(0);
  });

  it("uses conversation URL second and guarded unique name matching last", () => {
    const snapshot = parseLinkedInExtensionSnapshot({ ...rawSnapshot, contact: { ...rawSnapshot.contact, profileUrl: "" } }) as LinkedInExtensionSnapshot;
    const byConversation = contact({ id: "conversation", name: "Old display name", profileUrl: "", conversationUrl: snapshot.pageUrl });
    const conversationResult = upsertLinkedInSnapshot([byConversation], snapshot);
    expect(conversationResult.matchedBy).toBe("conversation");

    const noUrls = { ...snapshot, pageUrl: "" };
    const byName = contact({ id: "name", profileUrl: "", conversationUrl: "" });
    expect(upsertLinkedInSnapshot([byName], noUrls).matchedBy).toBe("name");
  });

  it("never merges an ambiguous identity", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const first = contact({ id: "duplicate-1" });
    const second = contact({ id: "duplicate-2" });
    const result = upsertLinkedInSnapshot([first, second], snapshot);
    expect(result.action).toBe("ambiguous");
    expect(result.contactId).toBe("");
    expect(result.contacts.every((item) => item.chat.length === 0)).toBe(true);
  });

  it("creates a distinct contact rather than name-merging conflicting profile URLs", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const sameNameDifferentProfile = contact({ id: "existing", profileUrl: "https://www.linkedin.com/in/different-alex/" });
    const result = upsertLinkedInSnapshot([sameNameDifferentProfile], snapshot);
    expect(result.action).toBe("created");
    expect(result.contacts).toHaveLength(2);
    expect(result.contacts.find((item) => item.id === "existing")?.chat).toHaveLength(0);
  });

  it("deduplicates both stable DOM IDs and fallback fingerprints", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const first = upsertLinkedInSnapshot([], snapshot);
    const fallback = {
      ...snapshot,
      captureId: "capture-fallback",
      messages: [{ ...snapshot.messages[0], id: "generated", sourceId: "" }],
    };
    const fallbackFirst = upsertLinkedInSnapshot(first.contacts, fallback);
    const fallbackSecond = upsertLinkedInSnapshot(fallbackFirst.contacts, { ...fallback, captureId: "capture-fallback-2" });
    expect(fallbackFirst.importedMessages).toBe(0);
    expect(fallbackSecond.importedMessages).toBe(0);
    expect(fallbackSecond.contacts[0].chat).toHaveLength(2);
  });

  it("reports safe message counts and a stable snapshot fingerprint", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const first = upsertLinkedInSnapshot([], snapshot);
    const incoming = {
      id: "event-3",
      sourceId: "urn:li:msg:3",
      role: "them" as const,
      speaker: "Alex Morgan",
      body: "Could you share the role details?",
      createdAt: "2026-08-02T12:04:00.000Z",
      attachments: [],
    };
    const result = upsertLinkedInSnapshot(first.contacts, {
      ...snapshot,
      captureId: "capture-with-diagnostics",
      capturedAt: "2026-08-02T12:05:00.000Z",
      messages: [...snapshot.messages, incoming],
    });

    expect(result.importedMessages).toBe(1);
    expect(result.duplicateMessages).toBe(2);
    expect(result.snapshotFingerprint).toMatch(/^[a-z0-9]+$/);
    expect(result.contacts[0].lastSyncDiagnostic).toEqual({
      action: "updated",
      visibleMessages: 3,
      importedMessages: 1,
      duplicateMessages: 2,
      restoredFromArchive: false,
      snapshotFingerprint: result.snapshotFingerprint,
      synchronizedAt: "2026-08-02T12:05:00.000Z",
    });
  });

  it("restores an archived conversation only for a genuinely new incoming message", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const initial = upsertLinkedInSnapshot([], snapshot).contacts[0];
    const archived = { ...initial, archivedAt: "2026-08-02T12:01:00.000Z", pipelineStage: "done" as const, notes: "preserve me", labels: ["priority"] };
    const incoming = {
      id: "event-archive-incoming",
      sourceId: "urn:li:msg:archive-incoming",
      role: "them" as const,
      speaker: "Alex Morgan",
      body: "I have a new question.",
      createdAt: "2026-08-02T12:06:00.000Z",
      attachments: [],
    };
    const result = upsertLinkedInSnapshot([archived], { ...snapshot, captureId: "capture-archive-incoming", capturedAt: "2026-08-02T12:07:00.000Z", messages: [...snapshot.messages, incoming] });
    const updated = result.contacts[0];

    expect(result.restoredFromArchive).toBe(true);
    expect(updated.archivedAt).toBe("");
    expect(updated.pipelineStage).toBe("inbox");
    expect(updated.notes).toBe("preserve me");
    expect(updated.labels).toEqual(["priority"]);
  });

  it("keeps archived conversations archived for duplicates, outgoing messages, and metadata-only updates", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const initial = upsertLinkedInSnapshot([], snapshot).contacts[0];
    const archived = { ...initial, archivedAt: "2026-08-02T12:01:00.000Z", pipelineStage: "done" as const };

    const duplicate = upsertLinkedInSnapshot([archived], { ...snapshot, captureId: "capture-archive-duplicate", capturedAt: "2026-08-02T12:08:00.000Z" });
    expect(duplicate.restoredFromArchive).toBe(false);
    expect(duplicate.contacts[0]).toMatchObject({ archivedAt: archived.archivedAt, pipelineStage: "done" });

    const outgoing = {
      id: "event-archive-outgoing",
      sourceId: "urn:li:msg:archive-outgoing",
      role: "me" as const,
      speaker: "You",
      body: "Following up from my side.",
      createdAt: "2026-08-02T12:09:00.000Z",
      attachments: [],
    };
    const outgoingResult = upsertLinkedInSnapshot([archived], { ...snapshot, captureId: "capture-archive-outgoing", capturedAt: "2026-08-02T12:10:00.000Z", messages: [...snapshot.messages, outgoing] });
    expect(outgoingResult.restoredFromArchive).toBe(false);
    expect(outgoingResult.contacts[0]).toMatchObject({ archivedAt: archived.archivedAt, pipelineStage: "done" });

    const metadataOnly = upsertLinkedInSnapshot([archived], { ...snapshot, captureId: "capture-archive-metadata", capturedAt: "2026-08-02T12:11:00.000Z", contact: { ...snapshot.contact, company: "Updated Example Co" } });
    expect(metadataOnly.restoredFromArchive).toBe(false);
    expect(metadataOnly.contacts[0]).toMatchObject({ archivedAt: archived.archivedAt, pipelineStage: "done", company: "Updated Example Co" });
  });

  it("deduplicates undated DOM messages across captures with different capture times", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const undated = {
      ...snapshot,
      captureId: "capture-undated-1",
      capturedAt: "2026-08-02T12:00:00.000Z",
      messages: [{ ...snapshot.messages[0], id: "generated-1", sourceId: "", createdAt: "" }],
    };
    const first = upsertLinkedInSnapshot([], undated);
    const second = upsertLinkedInSnapshot(first.contacts, {
      ...undated,
      captureId: "capture-undated-2",
      capturedAt: "2026-08-02T12:05:00.000Z",
      messages: [{ ...undated.messages[0], id: "generated-2" }],
    });
    expect(second.importedMessages).toBe(0);
    expect(second.contacts[0].chat).toHaveLength(1);
  });

  it("repairs 0.4.0 transient-ID duplicates and adopts the new stable fallback IDs", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const legacy = contact({
      chat: [
        { id: "linkedin-old1", role: "them", speaker: "Alex Morgan", body: "That would be great", createdAt: "2026-08-02T11:55:00.000Z", attachments: [] },
        { id: "linkedin-old2", role: "them", speaker: "Alex Morgan", body: "That would be great", createdAt: "2026-08-02T11:57:00.000Z", attachments: [] },
        { id: "linkedin-old3", role: "them", speaker: "Alex Morgan", body: "What inspired you to focus on zero trust?", createdAt: "2026-08-02T11:58:00.000Z", attachments: [] },
        { id: "linkedin-old4", role: "them", speaker: "Alex Morgan", body: "What inspired you to focus on zero trust?", createdAt: "2026-08-02T11:59:00.000Z", attachments: [] },
      ],
    });
    const currentSnapshot = {
      ...snapshot,
      captureId: "capture-repair",
      capturedAt: "2026-08-02T12:00:00.000Z",
      messages: [
        { id: "visible-message-great1", sourceId: "", role: "them" as const, speaker: "Alex Morgan", body: "That would be great", createdAt: "", attachments: [] },
        { id: "visible-message-question1", sourceId: "", role: "them" as const, speaker: "Alex Morgan", body: "What inspired you to focus on zero trust?", createdAt: "", attachments: [] },
      ],
    };

    const result = upsertLinkedInSnapshot([legacy], currentSnapshot);
    expect(result.importedMessages).toBe(0);
    expect(result.contacts[0].chat.map((message) => message.body)).toEqual([
      "That would be great",
      "What inspired you to focus on zero trust?",
    ]);
    expect(result.contacts[0].chat.every((message) => message.id.startsWith("linkedin-fallback-"))).toBe(true);
  });

  it("preserves genuinely repeated undated messages with distinct fallback occurrences", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const repeated = {
      ...snapshot,
      messages: [
        { id: "visible-message-thanks1", sourceId: "", role: "them" as const, speaker: "Alex Morgan", body: "Thanks", createdAt: "", attachments: [] },
        { id: "visible-message-thanks2", sourceId: "", role: "them" as const, speaker: "Alex Morgan", body: "Thanks", createdAt: "", attachments: [] },
      ],
    };
    const result = upsertLinkedInSnapshot([], repeated);
    expect(result.contacts[0].chat).toHaveLength(2);
    expect(new Set(result.contacts[0].chat.map((message) => message.id)).size).toBe(2);
  });

  it("surfaces snoozed and due conversations locally", () => {
    const now = new Date("2026-08-02T12:00:00.000Z").getTime();
    const base = contact();
    expect(isActivelySnoozed({ ...base, snoozedUntil: "2026-08-02T13:00:00.000Z" }, now)).toBe(true);
    expect(isReminderDue({ ...base, followUpAt: "2026-08-02T11:00:00.000Z" }, now)).toBe(true);
  });

  it("declares only opt-in LinkedIn host access and no cookie, network, or send capability", () => {
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as { version: string; permissions: string[]; host_permissions: string[]; optional_host_permissions: string[] };
    const sources = ["background.js", "extractor.js", "linkedin-sync.js", "app-bridge.js"].map((name) => readFileSync("extension/" + name, "utf8")).join("\n");
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toEqual([
      "https://chathelp-private-cloud.project-mission-ai.workers.dev/*",
      "https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/*",
    ]);
    expect(manifest.optional_host_permissions).toEqual(["https://www.linkedin.com/*"]);
    expect(manifest.host_permissions.some((permission) => permission.includes("linkedin.com"))).toBe(false);
    expect(manifest.version).toBe("0.5.0");
    expect(manifest.permissions).not.toContain("cookies");
    expect(manifest.permissions).not.toContain("webRequest");
    expect(sources).not.toMatch(/chrome\.cookies|chrome\.webRequest|chrome\.debugger|fetch\s*\(|XMLHttpRequest|\.click\s*\(/);
  });
});
