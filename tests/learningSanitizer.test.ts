import { describe, expect, it } from "vitest";
import { buildSanitizedPreview, findForbiddenIdentifier, sanitizeKnownIdentifiers } from "../src/lib/learningSanitizer";

describe("learning preview sanitizer", () => {
  it("replaces exact normalized known values before returning the exact preview", () => {
    expect(buildSanitizedPreview({
      text: "Priya at Contoso shared her profile https://linkedin.example/priya",
      known: { contactName: "Priya", company: "Contoso", profileUrl: "https://linkedin.example/priya", profileHandle: "" },
    })).toEqual({ ok: true, preview: "[contact] at [company] shared her profile [profile]" });
  });

  it("exposes the shared normalization, replacement, and residual-rejection contract", () => {
    expect(sanitizeKnownIdentifiers("Priya at Contoso", {
      contactName: "Priya",
      company: "Contoso",
      profileUrl: "",
      profileHandle: "",
    })).toBe("[contact] at [company]");
    expect(findForbiddenIdentifier("Call 416 555 0100")).toBe("phone_number");
  });

  it("rejects a residual email even when known identifiers were removed", () => {
    expect(buildSanitizedPreview({
      text: "Email Priya at priya@example.com about Contoso",
      known: { contactName: "Priya", company: "Contoso", profileUrl: "", profileHandle: "" },
    })).toEqual({ ok: false, reason: "email_address" });
  });

  it("normalizes Unicode before exact known-value replacement", () => {
    expect(buildSanitizedPreview({
      text: "Ａｎａ works at Acme\u00a0Corp",
      known: { contactName: "Ana", company: "Acme Corp", profileUrl: "", profileHandle: "" },
    })).toEqual({ ok: true, preview: "[contact] works at [company]" });
  });

  it("uses original Unicode source positions when replacing later known values", () => {
    expect(buildSanitizedPreview({
      text: "İ said Acme has a thoughtful approach",
      known: { contactName: "", company: "Acme", profileUrl: "", profileHandle: "" },
    })).toEqual({ ok: true, preview: "İ said [company] has a thoughtful approach" });
  });

  it("rejects every residual forbidden identifier class", () => {
    const cases: Array<[string, string]> = [
      ["url", "See www.example.com"],
      ["social_handle", "Ask @person"],
      ["phone_number", "Call 416 555 0100"],
      ["postal_address", "Meet at 12 Queen Road"],
      ["long_identifier", "Ticket 12345678"],
      ["control_character", "Hello\u0001"],
    ];
    for (const [reason, text] of cases) {
      expect(buildSanitizedPreview({ text, known: { contactName: "", company: "", profileUrl: "", profileHandle: "" } })).toEqual({ ok: false, reason });
    }
  });
});
