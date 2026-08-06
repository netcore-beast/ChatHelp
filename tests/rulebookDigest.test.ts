import { describe, expect, it } from "vitest";
import { RULEBOOK_DIGEST_MAX_CHARS, buildRulebookDigest } from "../src/lib/rulebookDigest";

describe("rulebook digest", () => {
  it("keeps actionable directives in source order and removes duplicates", () => {
    const rules = [
      "Background context for the playbook.",
      "1. Always answer the latest message.",
      "Never invent facts.",
      "NEVER INVENT FACTS.",
      "- Ask at most one question.",
    ].join("\n");

    expect(buildRulebookDigest(rules)).toBe([
      "1. Always answer the latest message.",
      "- Never invent facts.",
      "- Ask at most one question.",
    ].join("\n"));
  });

  it("falls back to a non-empty concise rule when no directive marker exists", () => {
    expect(buildRulebookDigest("Be warm and concise.")).toBe("- Be warm and concise.");
  });

  it("returns a bounded digest for repetitive long rulebooks", () => {
    const digest = buildRulebookDigest("Always stay factual. ".repeat(2_000));
    expect(digest.length).toBeLessThanOrEqual(RULEBOOK_DIGEST_MAX_CHARS);
    expect(digest).toBe("- Always stay factual.");
  });
});
