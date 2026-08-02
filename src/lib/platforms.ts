import type { Contact, ConversationPlatform } from "./workspaceTypes";

export const PLATFORM_OPTIONS: ReadonlyArray<{ value: ConversationPlatform; label: string; shortLabel: string }> = [
  { value: "linkedin", label: "LinkedIn Messaging", shortLabel: "LinkedIn" },
  { value: "gmail", label: "Gmail", shortLabel: "Gmail" },
  { value: "outlook", label: "Outlook", shortLabel: "Outlook" },
  { value: "other", label: "Other service", shortLabel: "Other" },
];

const DEFAULT_URLS: Record<Exclude<ConversationPlatform, "other">, string> = {
  linkedin: "https://www.linkedin.com/messaging/",
  gmail: "https://mail.google.com/mail/u/0/#inbox",
  outlook: "https://outlook.office.com/mail/",
};

export function safeLinkedInProfileUrl(value: string): string | null {
  if (!value.trim()) return null;

  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    const pathParts = normalizedPath.split("/").filter(Boolean);

    if (
      url.protocol !== "https:" ||
      (host !== "linkedin.com" && host !== "www.linkedin.com") ||
      pathParts.length !== 2 ||
      pathParts[0] !== "in" ||
      !pathParts[1]
    ) {
      return null;
    }

    url.hostname = "www.linkedin.com";
    url.pathname = normalizedPath;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function platformLabel(platform: ConversationPlatform | undefined): string {
  return PLATFORM_OPTIONS.find((option) => option.value === platform)?.shortLabel ?? "LinkedIn";
}

export function safePlatformUrl(contact: Pick<Contact, "platform" | "platformUrl" | "conversationUrl">): string | null {
  if (contact.platform === "linkedin" && contact.conversationUrl) {
    try {
      const url = new URL(contact.conversationUrl);
      if (url.protocol === "https:" && (url.hostname === "linkedin.com" || url.hostname === "www.linkedin.com") && url.pathname.startsWith("/messaging/")) {
        url.hostname = "www.linkedin.com";
        url.search = "";
        url.hash = "";
        return url.toString();
      }
    } catch {
      // Fall back to LinkedIn Messaging below.
    }
  }
  if (contact.platform !== "other") return DEFAULT_URLS[contact.platform];
  if (!contact.platformUrl.trim()) return null;
  try {
    const url = new URL(contact.platformUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
