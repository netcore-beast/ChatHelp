// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  RULES_DOCUMENT_MAX_BYTES,
  createRulesDocumentDownload,
  mergeRulesDocument,
} from "../src/lib/rulesDocument";

function rulesFile(name: string, text: string, type = "text/plain"): File {
  const file = new File([text], name, { type });
  Object.defineProperty(file, "text", { value: async () => text });
  return file;
}

describe("role reply-rules documents", () => {
  it("loads a rules document as an alternative to typing", async () => {
    await expect(mergeRulesDocument("", rulesFile("network-rules.txt", "Never pressure the contact.")))
      .resolves.toBe("Never pressure the contact.");
  });

  it("combines uploaded rules with typed rules without duplicating the same document", async () => {
    const file = rulesFile("network-rules.md", "Ask at most one question.", "text/markdown");
    const combined = await mergeRulesDocument("Keep every claim factual.", file);
    expect(combined).toBe("Keep every claim factual.\n\nAsk at most one question.");
    await expect(mergeRulesDocument(combined, file)).resolves.toBe(combined);
  });

  it("downloads exactly the current role's combined rules text", () => {
    expect(createRulesDocumentDownload("Network Marketing", "Typed rule.\n\nUploaded rule.")).toEqual({
      filename: "dialogmint-network-marketing-reply-rules.txt",
      text: "Typed rule.\n\nUploaded rule.",
    });
  });

  it("rejects binary, oversized, empty, and over-limit documents", async () => {
    await expect(mergeRulesDocument("", rulesFile("rules.docx", "binary", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")))
      .rejects.toThrow(/plain-text.*Markdown/);
    const oversized = rulesFile("rules.txt", "x");
    Object.defineProperty(oversized, "size", { value: RULES_DOCUMENT_MAX_BYTES + 1 });
    await expect(mergeRulesDocument("", oversized)).rejects.toThrow(/256 KB or smaller/);
    await expect(mergeRulesDocument("", rulesFile("rules.txt", "   "))).rejects.toThrow(/empty/);
    await expect(mergeRulesDocument("R".repeat(49_999), rulesFile("rules.txt", "More rules")))
      .rejects.toThrow(/exceed 50,000 characters/);
  });
});
