import { PLAYBOOK_RULES_MAX_CHARS, type MessagingRole } from "./workspaceTypes";

export const RULES_DOCUMENT_MAX_BYTES = 256 * 1024;
const ALLOWED_RULES_EXTENSIONS = [".txt", ".md", ".markdown"] as const;

function hasAllowedRulesFormat(file: File): boolean {
  const name = file.name.toLowerCase();
  return ALLOWED_RULES_EXTENSIONS.some((extension) => name.endsWith(extension))
    || file.type === "text/plain"
    || file.type === "text/markdown";
}

export async function mergeRulesDocument(currentRules: string, file: File): Promise<string> {
  if (file.size > RULES_DOCUMENT_MAX_BYTES) {
    throw new Error("Rules documents must be 256 KB or smaller.");
  }
  if (!hasAllowedRulesFormat(file)) {
    throw new Error("Choose a plain-text (.txt) or Markdown (.md) rules document.");
  }

  const uploadedRules = (await file.text()).replace(/^\uFEFF/, "").replace(/\u0000/g, "").trim();
  if (!uploadedRules) throw new Error("The selected rules document is empty.");

  const existingRules = currentRules.trim();
  const mergedRules = !existingRules
    ? uploadedRules
    : existingRules.includes(uploadedRules)
      ? existingRules
      : `${existingRules}\n\n${uploadedRules}`;
  if (mergedRules.length > PLAYBOOK_RULES_MAX_CHARS) {
    throw new Error(`The combined reply rules exceed ${PLAYBOOK_RULES_MAX_CHARS.toLocaleString()} characters.`);
  }
  return mergedRules;
}

export function createRulesDocumentDownload(role: MessagingRole, rules: string): { filename: string; text: string } {
  const text = rules.trim();
  if (!text) throw new Error("Add or upload reply rules before downloading them.");
  const roleSlug = role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    filename: `dialogmint-${roleSlug || "role"}-reply-rules.txt`,
    text,
  };
}
