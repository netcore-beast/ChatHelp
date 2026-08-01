'use client';

import { useState } from "react";
import { safeLinkedInProfileUrl } from "@/lib/platforms";
import type { Contact, Guidance } from "@/lib/workspaceTypes";

interface ProfileDraft {
  name: string;
  headline: string;
  notes: string;
}

interface LinkedInTestWizardProps {
  initialContact: Contact | null;
  guidance: Guidance;
  drafts: string[];
  aiStatus: string;
  onClose: () => void;
  onSaveProfile: (profile: ProfileDraft) => string;
  onCapture: (contactId: string) => Promise<void>;
  onImportChat: (contactId: string, text: string) => void;
  onGuidanceChange: (field: keyof Guidance, value: string) => void;
  onGenerate: (contactId: string, agenda: string) => Promise<void>;
}

const STEPS = ["Privacy", "Person", "Profile", "Chat", "Goal", "Drafts"];

export function LinkedInTestWizard({ initialContact, guidance, drafts, aiStatus, onClose, onSaveProfile, onCapture, onImportChat, onGuidanceChange, onGenerate }: LinkedInTestWizardProps) {
  const [step, setStep] = useState(0);
  const [consented, setConsented] = useState(false);
  const [contactId, setContactId] = useState(initialContact?.platform === "linkedin" ? initialContact.id : "");
  const [name, setName] = useState(initialContact?.platform === "linkedin" ? initialContact.name : "");
  const [headline, setHeadline] = useState(initialContact?.platform === "linkedin" ? initialContact.headline : "");
  const [notes, setNotes] = useState(initialContact?.platform === "linkedin" ? initialContact.profileNotes : "");
  const [profileUrl, setProfileUrl] = useState("");
  const [chatText, setChatText] = useState("");
  const [agenda, setAgenda] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [localError, setLocalError] = useState("");

  const safeProfileUrl = safeLinkedInProfileUrl(profileUrl);

  function saveProfile(): string {
    const id = onSaveProfile({ name: name.trim(), headline: headline.trim(), notes: notes.trim() });
    setContactId(id);
    return id;
  }

  function next() {
    setLocalError("");
    if (step === 0 && !consented) return setLocalError("Confirm the privacy checklist before continuing.");
    if (step === 1) {
      if (!name.trim()) return setLocalError("Add the person’s name or a private nickname.");
      if (profileUrl.trim() && !safeProfileUrl) return setLocalError("Use an https://www.linkedin.com/in/... profile URL.");
      saveProfile();
    }
    if (step === 2) saveProfile();
    if (step === 3 && chatText.trim()) {
      const id = contactId || saveProfile();
      onImportChat(id, chatText);
      setChatText("");
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  return (
    <div className="wizard-backdrop" role="presentation" onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <section className="wizard" role="dialog" aria-modal="true" aria-labelledby="wizard-title" data-testid="linkedin-test-wizard">
        <header className="wizard-header">
          <div><p className="eyebrow">GUIDED REAL-PROFILE TEST</p><h2 id="wizard-title">Test ChatHelp with one LinkedIn conversation</h2></div>
          <button type="button" className="dialog-close" aria-label="Close LinkedIn test wizard" onClick={onClose}>×</button>
        </header>
        <ol className="wizard-progress" aria-label="Wizard progress">
          {STEPS.map((label, index) => <li key={label} className={index === step ? "current" : index < step ? "done" : ""}><span>{index + 1}</span>{label}</li>)}
        </ol>

        <div className="wizard-body">
          {step === 0 && <div className="wizard-step">
            <p className="eyebrow">STEP 1 OF 6</p><h3>Start with a strict privacy boundary</h3>
            <p>This wizard never signs in to LinkedIn, reads your account in the background, or sends a message. You choose one profile and only the context you want ChatHelp to process.</p>
            <ul className="wizard-checks"><li>LinkedIn remains open in its own tab or app.</li><li>Screen OCR and draft generation run locally.</li><li>Selected context is encrypted in your vault.</li><li>You review, copy, and send manually.</li></ul>
            <label className="consent-check"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />I understand that I must have a legitimate reason to use this person’s information and should add only what is necessary.</label>
          </div>}

          {step === 1 && <div className="wizard-step">
            <p className="eyebrow">STEP 2 OF 6</p><h3>Choose one LinkedIn profile</h3>
            <p>Use a real profile you are permitted to contact. The URL stays in this temporary wizard and is not saved in the encrypted workspace.</p>
            <label>Person’s name or private nickname<input autoFocus value={name} onChange={(event) => setName(event.target.value.slice(0, 200))} placeholder="Example: Alex from Northwind" /></label>
            <label>LinkedIn profile URL<input type="url" value={profileUrl} onChange={(event) => setProfileUrl(event.target.value.slice(0, 2000))} placeholder="https://www.linkedin.com/in/..." /></label>
            {safeProfileUrl ? <a className="platform-link" href={safeProfileUrl} target="_blank" rel="noreferrer">Open this profile in LinkedIn ↗</a> : <p className="fine-print">Paste a complete LinkedIn member profile URL to enable the open button.</p>}
            <label>Headline or role<input value={headline} onChange={(event) => setHeadline(event.target.value.slice(0, 500))} placeholder="Role, company, or shared context" /></label>
          </div>}

          {step === 2 && <div className="wizard-step">
            <p className="eyebrow">STEP 3 OF 6</p><h3>Add only relevant profile context</h3>
            <p>Keep the LinkedIn profile visible, then choose that tab or window when the system picker appears. You can also type a short summary instead.</p>
            <button type="button" className="primary" disabled={capturing} onClick={async () => { const id = contactId || saveProfile(); setCapturing(true); setLocalError(""); try { await onCapture(id); } catch (error) { setLocalError(error instanceof Error ? error.message : "The selected screen could not be processed."); } finally { setCapturing(false); } }}>{capturing ? "Processing locally…" : "Choose a profile screen to capture"}</button>
            <label>Relevant profile notes<textarea value={notes} onChange={(event) => setNotes(event.target.value.slice(0, 20_000))} placeholder="Shared experience, current role, interests relevant to this conversation…" /></label>
            <p className="fine-print">Avoid sensitive or unrelated personal information. You can remove captured context from the person’s profile card at any time.</p>
          </div>}

          {step === 3 && <div className="wizard-step">
            <p className="eyebrow">STEP 4 OF 6</p><h3>Add the selected conversation</h3>
            <p>Open LinkedIn Messaging and paste only the lines needed to understand the current exchange.</p>
            <a className="platform-link" href="https://www.linkedin.com/messaging/" target="_blank" rel="noreferrer">Open LinkedIn Messaging ↗</a>
            <label>Selected chat lines<textarea value={chatText} onChange={(event) => setChatText(event.target.value.slice(0, 100_000))} placeholder={"Me: Great to reconnect.\nAlex: Likewise—what kind of partnership did you have in mind?"} /></label>
            <p className="fine-print">Prefix your lines with “Me:” or “I:”. Other lines are treated as the other person’s messages.</p>
          </div>}

          {step === 4 && <div className="wizard-step">
            <p className="eyebrow">STEP 5 OF 6</p><h3>Tell the private model how to help</h3>
            <label>Your role<input value={guidance.role} onChange={(event) => onGuidanceChange("role", event.target.value)} /></label>
            <label>Relationship goal<textarea value={guidance.objective} onChange={(event) => onGuidanceChange("objective", event.target.value)} /></label>
            <label>Voice<input value={guidance.voice} onChange={(event) => onGuidanceChange("voice", event.target.value)} /></label>
            <label>Boundaries<textarea value={guidance.boundaries} onChange={(event) => onGuidanceChange("boundaries", event.target.value)} /></label>
            <label>What should the next message accomplish?<textarea value={agenda} onChange={(event) => setAgenda(event.target.value.slice(0, 20_000))} placeholder="Answer their question, suggest a short call, and stay warm without sounding sales-driven." /></label>
          </div>}

          {step === 5 && <div className="wizard-step">
            <p className="eyebrow">STEP 6 OF 6</p><h3>Generate, review, and hand off manually</h3>
            <div className="wizard-review"><span><strong>Person</strong>{name || "Not provided"}</span><span><strong>Profile context</strong>{headline || notes ? "Added" : "Optional"}</span><span><strong>Chat</strong>{chatText ? "Ready to import" : "Imported or optional"}</span><span><strong>Goal</strong>{agenda || "Add an agenda before generating"}</span></div>
            {!generated && <button type="button" className="primary" disabled={!agenda.trim() || !contactId} onClick={async () => { setGenerated(true); await onGenerate(contactId, agenda); }}>Generate 3 private drafts</button>}
            {aiStatus && <p className="status" aria-live="polite">{aiStatus}</p>}
            {generated && !drafts.length && !aiStatus && <p className="status">Generation is starting locally…</p>}
            <div className="wizard-drafts">{drafts.map((draft, index) => <article className="draft-card" key={draft + index}><div><span>OPTION {index + 1}</span><button type="button" onClick={() => void navigator.clipboard.writeText(draft)}>Copy</button></div><p>{draft}</p></article>)}</div>
            {!!drafts.length && <a className="platform-link" href="https://www.linkedin.com/messaging/" target="_blank" rel="noreferrer">Open LinkedIn to review and paste manually ↗</a>}
          </div>}

          {localError && <p className="error" role="alert">{localError}</p>}
        </div>

        <footer className="wizard-actions">
          <button type="button" onClick={step === 0 ? onClose : () => { setLocalError(""); setStep((current) => Math.max(0, current - 1)); }}>{step === 0 ? "Cancel" : "Back"}</button>
          {step < STEPS.length - 1 ? <button type="button" className="primary" onClick={next}>Continue</button> : <button type="button" onClick={onClose}>Finish test</button>}
        </footer>
      </section>
    </div>
  );
}
