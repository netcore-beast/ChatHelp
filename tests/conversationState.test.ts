import { describe, expect, it } from "vitest";
import { deriveConversationState, sortPinnedThenRecent } from "../src/lib/conversationState";
import type { Contact, Message } from "../src/lib/workspaceTypes";

const now = new Date("2026-08-05T12:00:00.000Z").getTime();

function message(id: string, role: Message["role"], createdAt: string): Message {
  return { id, role, body: `${role}-${id}`, createdAt, speaker: role === "me" ? "You" : "Taylor Lee", attachments: [] };
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-base",
    name: "Taylor Lee",
    headline: "Talent Partner",
    profileNotes: "",
    platform: "linkedin",
    platformUrl: "",
    chat: [],
    documents: [],
    outcomes: [],
    retentionDays: 90,
    ...overrides,
  };
}

describe("derived conversation state", () => {
  it("applies the approved state precedence without storing duplicate status", () => {
    expect(deriveConversationState(contact({ archivedAt: "2026-08-05T11:00:00.000Z", readLater: true, chat: [message("incoming", "them", "2026-08-05T11:30:00.000Z")] }), now).code).toBe("archived");
    expect(deriveConversationState(contact({ snoozedUntil: "2026-08-05T13:00:00.000Z", readLater: true }), now).code).toBe("snoozed");
    expect(deriveConversationState(contact({ followUpAt: "2026-08-05T11:00:00.000Z", readLater: true }), now).code).toBe("follow-up-due");
    expect(deriveConversationState(contact({ readLater: true, chat: [message("incoming", "them", "2026-08-05T11:30:00.000Z")] }), now).code).toBe("read-later");
    expect(deriveConversationState(contact({ chat: [message("incoming", "them", "2026-08-05T11:30:00.000Z")] }), now).code).toBe("to-respond");
    expect(deriveConversationState(contact({ chat: [message("outgoing", "me", "2026-08-05T11:30:00.000Z")] }), now).code).toBe("awaiting-reply");
    expect(deriveConversationState(contact(), now).code).toBe("no-messages");
  });

  it("sorts pinned contacts first while preserving recency order within each group", () => {
    const result = sortPinnedThenRecent([
      contact({ id: "recent", chat: [message("recent", "them", "2026-08-05T11:55:00.000Z")] }),
      contact({ id: "pinned-older", pinned: true, chat: [message("pinned-old", "them", "2026-08-05T10:00:00.000Z")] }),
      contact({ id: "pinned-newer", pinned: true, chat: [message("pinned-new", "them", "2026-08-05T11:00:00.000Z")] }),
    ]);

    expect(result.map((item) => item.id)).toEqual(["pinned-newer", "pinned-older", "recent"]);
  });
});
