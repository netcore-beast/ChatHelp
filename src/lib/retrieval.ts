import type { Contact, ContextDocument } from "./workspaceTypes";

const STOP_WORDS = new Set(["the", "and", "for", "that", "with", "this", "you", "your", "are", "from", "have", "was", "but", "not"]);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter((token) => !STOP_WORDS.has(token));
}

export interface RankedContext {
  documentId: string;
  documentName: string;
  text: string;
  score: number;
}

export function chunkDocument(document: ContextDocument, maxCharacters = 900): RankedContext[] {
  const paragraphs = document.text.replace(/\r/g, "").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: RankedContext[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxCharacters) {
      chunks.push({ documentId: document.id, documentName: document.name, text: current, score: 0 });
      current = "";
    }
    if (paragraph.length > maxCharacters) {
      for (let offset = 0; offset < paragraph.length; offset += maxCharacters) {
        chunks.push({ documentId: document.id, documentName: document.name, text: paragraph.slice(offset, offset + maxCharacters), score: 0 });
      }
    } else {
      current += (current ? "\n\n" : "") + paragraph;
    }
  }
  if (current) chunks.push({ documentId: document.id, documentName: document.name, text: current, score: 0 });
  return chunks;
}

export function selectRelevantContext(documents: ContextDocument[], query: string, limit = 4): RankedContext[] {
  const queryTokens = new Set(tokens(query));
  if (!queryTokens.size) return documents.flatMap((document) => chunkDocument(document)).slice(0, limit);
  return documents
    .flatMap((document) => chunkDocument(document))
    .map((chunk) => {
      const unique = new Set(tokens(chunk.text));
      let overlap = 0;
      for (const token of queryTokens) if (unique.has(token)) overlap += 1;
      return { ...chunk, score: overlap / Math.sqrt(Math.max(1, unique.size)) };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function buildOutcomeSummary(contact: Contact): string {
  return contact.outcomes.slice(-20).map((outcome) => outcome.result + ": " + (outcome.note || "No note")).join("\n");
}

export function validateContextFile(file: Pick<File, "name" | "size" | "type">): string | null {
  const extension = file.name.toLowerCase().split(".").pop();
  if (!extension || !["txt", "md", "json"].includes(extension)) return "Only .txt, .md, and .json files are accepted.";
  if (file.size > 2 * 1024 * 1024) return "Context files must be 2 MB or smaller.";
  return null;
}
