export const RULEBOOK_DIGEST_MAX_CHARS = 8_000;

const DIRECTIVE_PATTERN = /\b(?:must|never|always|required|do not|don't|avoid|at most|should|shall|cannot|can't)\b/i;
const LIST_ITEM_PATTERN = /^(?:(\d+[.)])|[-*•])\s+(.+)$/;

function comparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function renderDirective(value: string): string {
  const trimmed = value.trim();
  const listItem = trimmed.match(LIST_ITEM_PATTERN);
  if (!listItem) return `- ${trimmed}`;
  return listItem[1] ? `${listItem[1]} ${listItem[2].trim()}` : `- ${listItem[2].trim()}`;
}

function appendBounded(lines: string[], value: string): boolean {
  const separatorLength = lines.length ? 1 : 0;
  const used = lines.reduce((total, line) => total + line.length, Math.max(0, lines.length - 1));
  const available = RULEBOOK_DIGEST_MAX_CHARS - used - separatorLength;
  if (available <= 0) return false;
  lines.push(value.slice(0, available).trimEnd());
  return value.length <= available;
}

export function buildRulebookDigest(rulebook: string): string {
  const sourceLines = rulebook.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates: string[] = [];

  for (const line of sourceLines) {
    if (LIST_ITEM_PATTERN.test(line)) {
      candidates.push(line);
      continue;
    }
    for (const sentence of line.match(/[^.!?]+[.!?]?/g) ?? []) {
      const trimmed = sentence.trim();
      if (trimmed && DIRECTIVE_PATTERN.test(trimmed)) candidates.push(trimmed);
    }
  }

  if (!candidates.length && sourceLines.length) {
    const firstSentence = sourceLines[0].match(/[^.!?]+[.!?]?/)?.[0]?.trim() ?? sourceLines[0];
    candidates.push(firstSentence);
  }

  const seen = new Set<string>();
  const digestLines: string[] = [];
  for (const candidate of candidates) {
    const rendered = renderDirective(candidate);
    const key = comparable(rendered.replace(/^\d+[.)]\s+|^-\s+/, ""));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!appendBounded(digestLines, rendered)) break;
  }
  return digestLines.join("\n");
}
