import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LINKEDIN_EXTENSION_SOURCE,
  isActivelySnoozed,
  isReminderDue,
  mergeLinkedInSnapshot,
  parseLinkedInExtensionSnapshot,
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

describe("explicit LinkedIn extension import", () => {
  it("validates and sanitizes the app-bound snapshot", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.pageUrl).toBe("https://www.linkedin.com/messaging/thread/abc/");
    expect(snapshot?.contact.profileUrl).toBe("https://www.linkedin.com/in/alex-morgan/");
    expect(snapshot?.contact.avatarUrl).toBe("https://media.licdn.com/dms/image/example");
    expect(snapshot?.messages[1].attachments).toEqual([{ id: "attachment-1", label: "Roadmap preview", kind: "image" }]);
  });

  it("upserts the contact, preserves workflow metadata, and deduplicates repeated captures", () => {
    const snapshot = parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot;
    const first = mergeLinkedInSnapshot([], snapshot);
    expect(first.importedMessages).toBe(2);
    expect(first.contacts[0].conversationUrl).toBe("https://www.linkedin.com/messaging/thread/abc/");
    expect(first.contacts[0].chat[1].attachments?.[0].label).toBe("Roadmap preview");

    const edited: Contact = { ...first.contacts[0], labels: ["warm lead"], notes: "Send the case study", pipelineStage: "warm" };
    const second = mergeLinkedInSnapshot([edited], { ...snapshot, captureId: "capture-2", capturedAt: "2026-08-02T12:05:00.000Z" });
    expect(second.importedMessages).toBe(0);
    expect(second.contacts[0].chat).toHaveLength(2);
    expect(second.contacts[0].labels).toEqual(["warm lead"]);
    expect(second.contacts[0].notes).toBe("Send the case study");
    expect(second.contacts[0].pipelineStage).toBe("warm");
  });

  it("surfaces snoozed and due conversations locally", () => {
    const now = new Date("2026-08-02T12:00:00.000Z").getTime();
    const base = mergeLinkedInSnapshot([], parseLinkedInExtensionSnapshot(rawSnapshot) as LinkedInExtensionSnapshot).contacts[0];
    expect(isActivelySnoozed({ ...base, snoozedUntil: "2026-08-02T13:00:00.000Z" }, now)).toBe(true);
    expect(isReminderDue({ ...base, followUpAt: "2026-08-02T11:00:00.000Z" }, now)).toBe(true);
    expect(isReminderDue({ ...base, followUpAt: "2026-08-03T11:00:00.000Z" }, now)).toBe(false);
  });

  it("uses minimal Chrome permissions and contains no send or network automation", () => {
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as { permissions: string[]; host_permissions: string[] };
    const background = readFileSync("extension/background.js", "utf8");
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions.some((permission) => permission.includes("linkedin.com"))).toBe(false);
    expect(background).toContain("chrome.action.onClicked");
    expect(background).toContain("chrome.scripting.executeScript");
    expect(background).not.toMatch(/\.click\s*\(/);
    expect(background).not.toMatch(/fetch\s*\(/);
    expect(background).not.toContain("XMLHttpRequest");
  });
});
