import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_EXTENSION_SOURCE,
  isActivelySnoozed,
  isCurrentLinkedInExtensionVersion,
  isLinkedInSnapshotForContact,
  isLikelyMobileDevice,
  isReminderDue,
  linkedInSelectionForContact,
  mergeLinkedInSnapshotForContact,
  parseLinkedInExtensionStatus,
  parseLinkedInExtensionSnapshot,
  recommendLinkedInCaptureMethod,
  type LinkedInExtensionSnapshot,
} from "../src/lib/linkedinExtension";
import type { Contact } from "../src/lib/workspaceTypes";

const rawSnapshot = {
  source: LINKEDIN_EXTENSION_SOURCE,
  version: 1,
  captureId: "capture-1",
  capturedAt: "2026-08-02T12:00:00.000Z",
  pageUrl: "https://www.linkedin.com/messaging/thread/abc/?tracking=remove-me",
  contact: {
    name: "Alex Morgan",
    headline: "VP Partnerships · Example Co",
    profileUrl: "https://linkedin.com/in/alex-morgan/?trk=secretish",
    avatarUrl: "https://media.licdn.com/dms/image/example?version=1",
  },
  messages: [
    { id: "event-1", role: "them", speaker: "Alex Morgan", body: "Thanks for connecting.", createdAt: "2026-08-02T11:58:00.000Z", attachments: [] },
    { id: "event-2", role: "me", speaker: "You", body: "What are you working on now?", createdAt: "2026-08-02T11:59:00.000Z", attachments: [{ id: "attachment-1", label: "Roadmap preview", kind: "image" }] },
  ],
};

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-alex",
    name: "Alex Morgan",
    headline: "",
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
    labels: [],
    pipelineStage: "inbox",
    notes: "",
    snoozedUntil: "",
    followUpAt: "",
    archivedAt: "",
    lastSyncedAt: "",
    draftHistory: [],
    ...overrides,
  };
}

describe("explicit LinkedIn extension import", () => {
  it("selects one safe import method from the device and extension capabilities", () => {
    expect(recommendLinkedInCaptureMethod({ detected: false, extensionConnected: false, isMobile: false, supportsScreenCapture: true })).toBe("detecting");
    expect(recommendLinkedInCaptureMethod({ detected: true, extensionConnected: true, isMobile: false, supportsScreenCapture: true })).toBe("extension");
    expect(recommendLinkedInCaptureMethod({ detected: true, extensionConnected: false, isMobile: false, supportsScreenCapture: true })).toBe("extension");
    expect(recommendLinkedInCaptureMethod({ detected: true, extensionConnected: true, isMobile: true, supportsScreenCapture: true })).toBe("manual");
    expect(recommendLinkedInCaptureMethod({ detected: true, extensionConnected: false, isMobile: false, supportsScreenCapture: false })).toBe("extension");
    expect(isLikelyMobileDevice("Mozilla/5.0 (Linux; Android 16; Mobile)")).toBe(true);
    expect(isLikelyMobileDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 5)).toBe(true);
    expect(isLikelyMobileDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });

  it("validates and sanitizes the app-bound snapshot", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.pageUrl).toBe("https://www.linkedin.com/messaging/thread/abc/");
    expect(snapshot?.contact.profileUrl).toBe("https://www.linkedin.com/in/alex-morgan/");
    expect(snapshot?.contact.avatarUrl).toBe("https://media.licdn.com/dms/image/example");
    expect(snapshot?.messages[1].attachments).toEqual([{ id: "attachment-1", label: "Roadmap preview", kind: "image" }]);
  });

  it("validates extension versions and safe capture status details", () => {
    expect(isCurrentLinkedInExtensionVersion("0.3.0")).toBe(true);
    expect(isCurrentLinkedInExtensionVersion("0.4.0")).toBe(true);
    expect(isCurrentLinkedInExtensionVersion("0.2.9")).toBe(false);
    expect(isCurrentLinkedInExtensionVersion(undefined)).toBe(false);
    expect(parseLinkedInExtensionStatus({
      source: LINKEDIN_EXTENSION_SOURCE,
      version: 1,
      statusId: "status-1",
      occurredAt: "2026-08-02T12:00:00.000Z",
      kind: "error",
      code: "contact_mismatch",
      message: "The open conversation is Amit Dabral.",
      observedContact: { name: "Amit Dabral", profileUrl: "https://linkedin.com/in/amit-dabral?trk=remove" },
    })).toMatchObject({
      code: "contact_mismatch",
      observedContact: { name: "Amit Dabral", profileUrl: "https://www.linkedin.com/in/amit-dabral/" },
    });
  });

  it("imports only into the selected matching contact and never creates another contact", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const selected = contact({ labels: ["warm lead"], notes: "Send the case study", pipelineStage: "warm" });
    expect(linkedInSelectionForContact(selected)).toEqual({ contactId: "contact-alex", name: "Alex Morgan", profileUrl: "https://www.linkedin.com/in/alex-morgan/" });
    expect(isLinkedInSnapshotForContact(selected, snapshot)).toBe(true);
    const first = mergeLinkedInSnapshotForContact([selected], selected.id, snapshot);
    if (!first) throw new Error("Expected the selected contact capture to import.");
    expect(first.importedMessages).toBe(2);
    expect(first.contacts).toHaveLength(1);
    expect(first.contacts[0].conversationUrl).toBe("https://www.linkedin.com/messaging/thread/abc/");
    expect(first.contacts[0].chat[1].attachments?.[0].label).toBe("Roadmap preview");

    const second = mergeLinkedInSnapshotForContact(first.contacts, selected.id, { ...snapshot, captureId: "capture-2", capturedAt: "2026-08-02T12:05:00.000Z" });
    if (!second) throw new Error("Expected the repeated selected contact capture to import.");
    expect(second.importedMessages).toBe(0);
    expect(second.contacts[0].chat).toHaveLength(2);
    expect(second.contacts[0].labels).toEqual(["warm lead"]);
    expect(second.contacts[0].notes).toBe("Send the case study");
    expect(second.contacts[0].pipelineStage).toBe("warm");

    const wrongContact = contact({ id: "contact-taylor", name: "Taylor Lee", profileUrl: "https://www.linkedin.com/in/taylor-lee/" });
    expect(isLinkedInSnapshotForContact(wrongContact, snapshot)).toBe(false);
    expect(mergeLinkedInSnapshotForContact([wrongContact], wrongContact.id, snapshot)).toBeNull();
    expect(mergeLinkedInSnapshotForContact([], selected.id, snapshot)).toBeNull();
  });

  it("surfaces snoozed and due conversations locally", () => {
    const now = new Date("2026-08-02T12:00:00.000Z").getTime();
    const base = mergeLinkedInSnapshotForContact([contact()], "contact-alex", parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot)?.contacts[0] as Contact;
    expect(isActivelySnoozed({ ...base, snoozedUntil: "2026-08-02T13:00:00.000Z" }, now)).toBe(true);
    expect(isReminderDue({ ...base, followUpAt: "2026-08-02T11:00:00.000Z" }, now)).toBe(true);
    expect(isReminderDue({ ...base, followUpAt: "2026-08-03T11:00:00.000Z" }, now)).toBe(false);
  });

  it("uses minimal Chrome permissions and contains no send or network automation", () => {
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as { version: string; permissions: string[]; host_permissions: string[] };
    const background = readFileSync("extension/background.js", "utf8");
    const extractor = readFileSync("extension/extractor.js", "utf8");
    const bridge = readFileSync("extension/app-bridge.js", "utf8");
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.version).toBe("0.3.0");
    expect(manifest.host_permissions.some((permission) => permission.includes("linkedin.com"))).toBe(false);
    expect(background).toContain("chrome.action.onClicked");
    expect(background).toContain("chrome.scripting.executeScript");
    expect(background).toContain("CHATHELP_SET_SELECTED_LINKEDIN_CONTACT");
    expect(extractor.indexOf("identityMatches")).toBeLessThan(extractor.indexOf("const eventNodes"));
    expect(background).not.toMatch(/\.click\s*\(/);
    expect(background).not.toMatch(/fetch\s*\(/);
    expect(background).not.toContain("XMLHttpRequest");
    expect(extractor).not.toMatch(/\.click\s*\(/);
    expect(extractor).not.toMatch(/fetch\s*\(/);
    expect(bridge).toContain("announceReady();");
    expect(bridge).toContain("event.data.type === REQUEST");
  });
});
