import { describe, expect, it } from "vitest";
import { platformLabel, safeLinkedInProfileUrl, safePlatformUrl } from "@/lib/platforms";
import type { Contact } from "@/lib/workspaceTypes";

const contact = (platform: Contact["platform"], platformUrl = ""): Contact => ({
  id: "contact-1",
  name: "Alex",
  headline: "Founder",
  profileNotes: "",
  platform,
  platformUrl,
  chat: [],
  documents: [],
  outcomes: [],
  retentionDays: 90,
});

describe("platform handoff", () => {
  it("uses fixed HTTPS destinations for supported services", () => {
    expect(safePlatformUrl(contact("linkedin"))).toBe("https://www.linkedin.com/messaging/");
    expect(safePlatformUrl(contact("gmail"))).toContain("https://mail.google.com/");
    expect(safePlatformUrl(contact("outlook"))).toBe("https://outlook.office.com/mail/");
  });

  it("allows only HTTPS custom service destinations", () => {
    expect(safePlatformUrl(contact("other", "https://example.com/messages"))).toBe("https://example.com/messages");
    expect(safePlatformUrl(contact("other", "http://example.com"))).toBeNull();
    expect(safePlatformUrl(contact("other", "javascript:alert(1)"))).toBeNull();
  });

  it("provides safe labels for migrated and unknown values", () => {
    expect(platformLabel("gmail")).toBe("Gmail");
    expect(platformLabel(undefined)).toBe("LinkedIn");
  });

  it("accepts only direct HTTPS LinkedIn member profile links", () => {
    expect(safeLinkedInProfileUrl("https://linkedin.com/in/alex-example/?trk=test#about")).toBe("https://www.linkedin.com/in/alex-example");
    expect(safeLinkedInProfileUrl("http://www.linkedin.com/in/alex-example")).toBeNull();
    expect(safeLinkedInProfileUrl("https://example.com/in/alex-example")).toBeNull();
    expect(safeLinkedInProfileUrl("https://www.linkedin.com/company/example")).toBeNull();
    expect(safeLinkedInProfileUrl("javascript:alert(1)")).toBeNull();
  });
});
