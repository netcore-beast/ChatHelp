export const LEARNING_POLICY_VERSION = 1 as const;

export const GOAL_CATEGORY_BY_STAGE = Object.freeze({
  new_connection: "connect",
  genuine_rapport: "build_rapport",
  learn_interests: "discover_interests",
  identify_need: "identify_need",
  ask_permission: "request_permission",
  introduce_value: "present_value",
  answer_without_pressure: "answer_questions",
  voluntary_next_step: "agree_next_step",
});

const FORBIDDEN: ReadonlyArray<readonly [SanitizerRejectionReason, RegExp]> = [
  ["email_address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
  ["url", /\b(?:https?:\/\/|www\.)\S+/iu],
  ["social_handle", /(^|\s)@[A-Z0-9_]{2,30}\b/iu],
  ["phone_number", /(?:\+?\d[\s().-]*){8,}/u],
  ["postal_address", /\b\d{1,6}\s+[\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr)\b/iu],
  ["long_identifier", /\b\d{8,}\b/u],
  ["control_character", /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u],
];

export type SanitizerRejectionReason =
  | "email_address"
  | "url"
  | "social_handle"
  | "phone_number"
  | "postal_address"
  | "long_identifier"
  | "control_character"
  | "invalid_text";

export interface SanitizedPreviewInput {
  text: string;
  known: {
    contactName: string;
    company: string;
    profileUrl: string;
    profileHandle: string;
  };
}

export type SanitizedPreviewResult =
  | { ok: true; preview: string }
  | { ok: false; reason: SanitizerRejectionReason };

function normalizeLearningText(value: string): string {
  return value.normalize("NFKC").trim();
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceKnownValue(text: string, known: string, replacement: string): string {
  const value = normalizeLearningText(known);
  if (!value) return text;
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_@.])${escapedRegExp(value)}(?![\\p{L}\\p{N}_@.])`, "giu"), replacement);
}

function hasKnownIdentifiers(known: unknown): known is SanitizedPreviewInput["known"] {
  if (!known || typeof known !== "object") return false;
  const value = known as Record<string, unknown>;
  return ["contactName", "company", "profileUrl", "profileHandle"].every((key) => typeof value[key] === "string");
}

export function findForbiddenIdentifier(text: string): SanitizerRejectionReason | null {
  const longIdentifier = FORBIDDEN.find(([reason]) => reason === "long_identifier");
  if (longIdentifier?.[1].test(text)) return "long_identifier";
  for (const [reason, pattern] of FORBIDDEN) {
    if (reason === "long_identifier") continue;
    if (pattern.test(text)) return reason;
  }
  return null;
}

export function sanitizeKnownIdentifiers(text: string, known: SanitizedPreviewInput["known"]): string {
  let sanitized = normalizeLearningText(text);
  sanitized = replaceKnownValue(sanitized, known.profileUrl, "[profile]");
  sanitized = replaceKnownValue(sanitized, known.profileHandle, "[profile]");
  sanitized = replaceKnownValue(sanitized, known.contactName, "[contact]");
  return replaceKnownValue(sanitized, known.company, "[company]");
}

export function buildSanitizedPreview(input: SanitizedPreviewInput): SanitizedPreviewResult {
  if (!input || typeof input.text !== "string") return { ok: false, reason: "invalid_text" };
  let preview = normalizeLearningText(input.text);
  if (!preview || preview.length > 2_000 || !hasKnownIdentifiers(input.known)) return { ok: false, reason: "invalid_text" };
  preview = sanitizeKnownIdentifiers(preview, input.known);
  const reason = findForbiddenIdentifier(preview);
  return reason ? { ok: false, reason } : { ok: true, preview };
}
