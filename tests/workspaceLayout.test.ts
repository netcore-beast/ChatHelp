import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/components/ChatHelpApp.tsx", "utf8");
const styles = readFileSync("src/app/globals.css", "utf8");

describe("desktop conversation workspace layout", () => {
  it("provides the requested navigation, inbox filters, drafting action, and contact context", () => {
    for (const destination of ["Inbox", "Contacts", "Pipeline", "Reminders", "Labels", "Archived", "Settings"]) {
      expect(app).toContain(`label: "${destination}"`);
    }
    for (const filter of ["Main inbox", "To respond", "Awaiting reply", "Follow-up due", "Snoozed", "New contacts", "Archived"]) {
      expect(app).toContain(`label: "${filter}"`);
    }
    expect(app).toContain('"Generate 3 Drafts"');
    expect(app).toContain("Open LinkedIn to review and paste");
    expect(app).toContain('aria-label="Contact context"');
    expect(styles).toContain(".prompt-composer");
    expect(styles).toContain(".prompt-composer-actions");
    expect(styles).toContain("@media (max-width: 360px)");
    expect(styles).toMatch(/\.prompt-composer-actions\s+\.draft-generate-button\s*\{[^}]*width:\s*100%/s);
    for (const excluded of ["Add members", "Export to HubSpot", "Enrich now", "Find business email", "Find phone number"]) {
      expect(app).not.toContain(excluded);
    }
  });

  it("defines large, laptop, and mobile panel behavior", () => {
    expect(styles).toContain("grid-template-columns: 176px 330px minmax(480px, 1fr) 320px");
    expect(styles).toContain("@media (max-width: 1180px)");
    expect(styles).toMatch(/@media \(max-width: 1180px\)[\s\S]*?\.contact-context \{ display: none;/);
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.mobile-list-hidden/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.mobile-conversation-hidden/);
  });
});
