import type { Message } from "./workspaceTypes";

const LEGACY_LINKEDIN_MESSAGE_ID = /^linkedin-[a-z0-9]+$/i;
const LEGACY_CAPTURE_WINDOW_MS = 15 * 60 * 1_000;

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").normalize("NFKC").toLocaleLowerCase();
}

export function linkedInMessageContentKey(message: Pick<Message, "role" | "speaker" | "body" | "attachments">): string {
  const attachments = (message.attachments ?? [])
    .map((attachment) => `${attachment.kind}:${normalizedText(attachment.label)}`)
    .join("|");
  return [message.role, normalizedText(message.speaker ?? ""), normalizedText(message.body), attachments].join("|");
}

export function isLegacyLinkedInMessageId(id: string): boolean {
  return LEGACY_LINKEDIN_MESSAGE_ID.test(id);
}

/**
 * Repairs duplicates created by ChatHelp 0.4.0, which trusted LinkedIn's
 * transient DOM element IDs and used capture time for messages without an
 * exact datetime. The narrow legacy-ID and short-time-window checks avoid
 * collapsing intentionally repeated messages imported by newer versions.
 */
export function repairLegacyLinkedInMessages(messages: Message[]): Message[] {
  const seenIds = new Set<string>();
  const recentLegacyByContent = new Map<string, number>();
  const repaired: Message[] = [];

  for (const message of messages) {
    if (seenIds.has(message.id)) continue;
    seenIds.add(message.id);

    if (isLegacyLinkedInMessageId(message.id)) {
      const createdAt = Date.parse(message.createdAt);
      const contentKey = linkedInMessageContentKey(message);
      const previous = recentLegacyByContent.get(contentKey);
      if (Number.isFinite(createdAt)) {
        recentLegacyByContent.set(contentKey, createdAt);
        if (previous !== undefined && Math.abs(createdAt - previous) <= LEGACY_CAPTURE_WINDOW_MS) continue;
      }
    }

    repaired.push(message);
  }

  return repaired;
}
