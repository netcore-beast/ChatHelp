import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync("src/components/ChatHelpApp.tsx", "utf8");
const composer = readFileSync("src/components/DraftComposer.tsx", "utf8");
const completedDraft = readFileSync("src/components/CompletedDraftCard.tsx", "utf8");
const progress = readFileSync("src/components/DraftProgressPanel.tsx", "utf8");
const usageSettings = readFileSync("src/components/UsageSettingsCard.tsx", "utf8");
const styles = readFileSync("src/app/globals.css", "utf8");
const draftingUi = [app, composer, completedDraft, progress].join("\n");

describe("desktop conversation workspace layout", () => {
  it("provides the requested navigation, inbox filters, drafting action, and collapsed right context panel", () => {
    for (const destination of ["Inbox", "Contacts", "Pipeline", "Reminders", "Labels", "Archived", "Settings"]) {
      expect(app).toContain(`label: "${destination}"`);
    }
    for (const filter of ["Main inbox", "To respond", "Awaiting reply", "Follow-up due", "Snoozed", "New contacts", "Archived"]) {
      expect(app).toContain(`label: "${filter}"`);
    }
    expect(draftingUi).toContain('"Generate Precise Draft"');
    expect(draftingUi).toContain('aria-label="Relationship stage"');
    expect(draftingUi).toContain('aria-label="Conversation goal"');
    expect(app).toContain("Open LinkedIn to review and paste");
    expect(app).toContain('aria-label={contactContextOpen ? "Hide contact details" : "Show contact details"}');
    expect(app).toContain('hidden={!contactContextOpen} aria-hidden={!contactContextOpen}');
    expect(styles).toContain(".contact-context-toggle");
    expect(styles).toContain(".workspace-frame.context-is-expanded");
    expect(styles).toContain(".prompt-composer");
    expect(styles).toContain(".prompt-composer-actions");
    expect(styles).toContain("@media (max-width: 360px)");
    expect(styles).toMatch(/\.prompt-composer-actions\s+\.draft-generate-button\s*\{[^}]*width:\s*100%/s);
    for (const excluded of ["Add members", "Export to HubSpot", "Enrich now", "Find business email", "Find phone number"]) {
      expect(draftingUi).not.toContain(excluded);
    }
  });

  it("defines large, laptop, and mobile panel behavior", () => {
    expect(app).toContain('<aside className="workspace-nav"');
    expect(app).toContain('aria-label={item.label}');
    expect(app).not.toContain('aria-label="Workspace view"');
    expect(styles).toContain("grid-template-columns: 176px 330px minmax(480px, 1fr)");
    expect(styles).toContain("@media (max-width: 1180px)");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.mobile-list-hidden/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.mobile-conversation-hidden/);
  });

  it("keeps compact drafting responsive, theme-safe, focus-visible, and motion-reduced", () => {
    expect(composer).toContain('className="composer-card draft-composer"');
    expect(composer).toContain('aria-label="Optional instruction"');
    expect(composer).toContain("<summary onClick={() => setAdvancedOpen((current) => !current)}>Advanced</summary>");
    expect(completedDraft).toContain('className="draft-primary-actions"');
    expect(completedDraft).toContain('aria-pressed={usefulSelected}');
    expect(completedDraft).toContain('aria-pressed={notUsefulSelected}');
    expect(completedDraft).toContain('Add my own version');
    expect(completedDraft).not.toContain('draft-more-actions');
    expect(completedDraft).toContain('className="draft-primary-actions"');
    expect(completedDraft).toContain('className="draft-provider-metadata"');
    expect(progress).toContain('hidden={!expanded}');

    expect(styles).toMatch(/\.prompt-composer textarea\s*\{[^}]*height:\s*48px;[^}]*min-height:\s*42px;[^}]*max-height:\s*56px;/);
    expect(styles).toMatch(/\.draft-provider-metadata dd\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    expect(styles).toMatch(/\.advanced-provider-note\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    expect(styles).toMatch(/\.prompt-composer:focus-within\s*\{[^}]*outline:\s*3px solid var\(--green\);/);
    expect(styles).toMatch(/@media \(max-width:\s*760px\)[\s\S]*?\.composer-advanced-content \.stage-goal-controls\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(styles).toMatch(/@media \(max-width:\s*360px\)[\s\S]*?\.prompt-composer-actions \.draft-generate-button\s*\{[^}]*width:\s*100%/);
    expect(styles).toMatch(/@media \(max-width:\s*360px\)[\s\S]*?\.draft-primary-actions\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(styles).toContain(':root:not([data-theme="light"]) .draft-learning-action');
    expect(styles).toContain('.draft-learning-action:focus-visible');
    expect(styles).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?\.draft-learning-status/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.draft-learning-status/);
    expect(styles).toMatch(/\.draft-learning-status\[data-kind="saved"\]\s*\{[^}]*animation:\s*draft-learning-saved-in\s+\.18s\s+ease-out\s+both;/);
    expect(styles).toMatch(/@keyframes draft-learning-saved-in\s*\{[\s\S]*?from\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*translateY\(4px\);[\s\S]*?to\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translateY\(0\);/);
    expect(styles).toContain(':root:not([data-theme="light"]) .composer-advanced');
    expect(styles).toContain(':root:not([data-theme="light"]) .draft-provider-metadata > div');
    expect(styles).toContain(':root:not([data-theme="light"]) :focus-visible');
    expect(styles).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.draft-progress-content li\[data-status="in-progress"\] \.draft-step-icon\s*\{[^}]*animation:\s*none;/);
  });

  it("invalidates draft identity synchronously on every direct contact selection path", () => {
    expect(app).toContain("synchronizeActiveDraftContact(preview.contactId);");
    expect(app).toMatch(/const setActiveContactId[\s\S]*?synchronizeActiveDraftContact\(contactId\);[\s\S]*?setSelectedId\(contactId\);/);
    expect(app).toContain('synchronizeActiveDraftContact(next.contacts[0]?.id ?? "");');
  });

  it("keeps per-provider allowance cards compact, responsive, theme-safe, and unclipped", () => {
    expect(app).toMatch(/<LearningSettingsCard[\s\S]*?\/>\s*<UsageSettingsCard summary=\{cloudUsage\}/);
    expect(usageSettings).toContain('<details className="usage-advanced">');
    expect(usageSettings).toMatch(/<summary[^>]*aria-label=\{`\$\{providerName\} Advanced`\}[^>]*>Advanced<\/summary>/);
    expect(styles).toMatch(/\.usage-settings-card\s*\{[^}]*grid-column:\s*1 \/ -1;/);
    expect(styles).toMatch(/\.usage-provider-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    expect(styles).toMatch(/\.usage-model-heading strong\s*\{[^}]*overflow-wrap:\s*anywhere;/);
    expect(styles).toMatch(/\.usage-advanced > summary:focus-visible\s*\{[^}]*outline:/);
    expect(styles).toMatch(/@media \(max-width:\s*1180px\)[\s\S]*?\.usage-provider-grid\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(styles).toMatch(/@media \(max-width:\s*1180px\)[\s\S]*?\.usage-token-totals\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    expect(styles).toMatch(/@media \(max-width:\s*360px\)[\s\S]*?\.usage-token-totals\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(styles).toContain(':root:not([data-theme="light"]) .usage-provider-card');
    expect(styles).toContain(':root:not([data-theme="light"]) .usage-advanced');
    expect(styles).toContain(':root:not([data-theme="light"]) .usage-model-row');
  });
});
