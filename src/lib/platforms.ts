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

export function platformLabel(platform: ConversationPlatform): string {
  return PLATFORM_OPTIONS.find((option) => option.value === platform)?.shortLabel ?? "LinkedIn";
}

export function safePlatformUrl(contact: Pick<Contact, "platform" | "platformUrl">): string | null {
  if (contact.platform !== "other") return DEFAULT_URLS[contact.platform];
  if (!contact.platformUrl.trim()) return null;
  try {
    const url = new URL(contact.platformUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
