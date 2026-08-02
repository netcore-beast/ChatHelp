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
  onCapture: (contactId: string, purpose: "profile" | "chat") => Promise<void>;
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
            <p>This wizard never signs in to LinkedIn, reads your account in the background, or sends a message. You choose one contact, their profile screen, and the conversation screen you want ChatHelp to process.</p>
            <ul className="wizard-checks"><li>LinkedIn remains open in its own tab or app.</li><li>Screen OCR runs locally; the captured image is not uploaded.</li><li>Draft generation runs in Cloudflare Workers AI; no LLM is downloaded to this device.</li><li>Selected text context is encrypted in your vault.</li><li>You review, copy, and send manually.</li></ul>
            <label className="consent-check"><input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />I understand that I must have a legitimate reason to use this person’s information and should add only what is necessary.</label>
          </div>}

          {step === 1 && <div className="wizard-step">
            <p className="eyebrow">STEP 2 OF 6</p><h3>Select the LinkedIn contact who will receive your reply</h3>
            <p>This is the other person—not you, the ChatHelp user. Use a real profile you are permitted to contact. The URL stays in this temporary wizard and is not saved in the encrypted workspace.</p>
            <label>Selected contact’s name or private nickname<input autoFocus value={name} onChange={(event) => setName(event.target.value.slice(0, 200))} placeholder="Example: Alex from Northwind" /></label>
            <label>LinkedIn profile URL<input type="url" value={profileUrl} onChange={(event) => setProfileUrl(event.target.value.slice(0, 2000))} placeholder="https://www.linkedin.com/in/..." /></label>
            {safeProfileUrl ? <a className="platform-link" href={safeProfileUrl} target="_blank" rel="noreferrer">Open this profile in LinkedIn ↗</a> : <p className="fine-print">Paste a complete LinkedIn member profile URL to enable the open button.</p>}
            <label>Headline or role<input value={headline} onChange={(event) => setHeadline(event.target.value.slice(0, 500))} placeholder="Role, company, or shared context" /></label>
          </div>}

          {step === 2 && <div className="wizard-step">
            <p className="eyebrow">STEP 3 OF 6</p><h3>Capture {name || "the contact"}&apos;s profile—not your profile</h3>
            <p>Open the selected contact&apos;s LinkedIn profile first. Click below, then choose the tab or window showing that profile in the system picker. Do not choose your own profile or the messaging screen in this step.</p>
            <button type="button" className="primary" disabled={capturing} onClick={async () => { const id = contactId || saveProfile(); setCapturing(true); setLocalError(""); try { await onCapture(id, "profile"); } catch (error) { setLocalError(error instanceof Error ? error.message : "The selected screen could not be processed."); } finally { setCapturing(false); } }}>{capturing ? "Processing profile screen locally…" : `Capture ${name || "the contact"}'s LinkedIn profile screen`}</button>
            <label>Relevant notes about {name || "the contact"}<textarea value={notes} onChange={(event) => setNotes(event.target.value.slice(0, 20_000))} placeholder="Current role, relevant expertise, or conversation-specific context…" /></label>
            <p className="fine-print">Avoid sensitive or unrelated personal information. You can remove captured context from the person’s profile card at any time.</p>
          </div>}

          {step === 3 && <div className="wizard-step">
            <p className="eyebrow">STEP 4 OF 6</p><h3>Capture your conversation with {name || "the contact"}</h3>
            <p>Open LinkedIn Messaging, select the conversation with {name || "the contact"}, and scroll until the latest incoming message plus enough recent history are visible. Then choose that messaging tab or window in the system picker. Repeat after scrolling if you need older history.</p>
            <a className="platform-link" href="https://www.linkedin.com/messaging/" target="_blank" rel="noreferrer">Open LinkedIn Messaging ↗</a>
            <button type="button" className="primary" disabled={capturing} onClick={async () => { const id = contactId || saveProfile(); setCapturing(true); setLocalError(""); try { await onCapture(id, "chat"); } catch (error) { setLocalError(error instanceof Error ? error.message : "The selected conversation screen could not be processed."); } finally { setCapturing(false); } }}>{capturing ? "Processing conversation screen locally…" : `Capture conversation screen with ${name || "the contact"}`}</button>
            <label>Optional manual chat lines<textarea value={chatText} onChange={(event) => setChatText(event.target.value.slice(0, 100_000))} placeholder={"Me: Great to reconnect.\nAlex: Likewise—what kind of partnership did you have in mind?"} /></label>
            <p className="fine-print">Prefix your lines with “Me:” or “I:”. Other lines are treated as the other person’s messages.</p>
          </div>}

          {step === 4 && <div className="wizard-step">
            <p className="eyebrow">STEP 5 OF 6</p><h3>Describe you—the person sending the reply</h3>
            <p>These settings are about you and your communication style. They are not profile details about {name || "the selected contact"}.</p>
            <label>Your role or team<input value={guidance.role} onChange={(event) => onGuidanceChange("role", event.target.value)} /></label>
            <label>Your relationship goal with {name || "this contact"}<textarea value={guidance.objective} onChange={(event) => onGuidanceChange("objective", event.target.value)} /></label>
            <label>How your messages should sound<input value={guidance.voice} onChange={(event) => onGuidanceChange("voice", event.target.value)} /></label>
            <label>Rules every reply must follow<textarea value={guidance.boundaries} onChange={(event) => onGuidanceChange("boundaries", event.target.value)} /></label>
            <label>What should the next message accomplish?<textarea value={agenda} onChange={(event) => setAgenda(event.target.value.slice(0, 20_000))} placeholder="Answer their question, suggest a short call, and stay warm without sounding sales-driven." /></label>
          </div>}

          {step === 5 && <div className="wizard-step">
            <p className="eyebrow">STEP 6 OF 6</p><h3>Generate, review, and hand off manually</h3>
            <div className="wizard-review"><span><strong>Person</strong>{name || "Not provided"}</span><span><strong>Profile context</strong>{headline || notes ? "Added" : "Optional"}</span><span><strong>Chat</strong>{chatText ? "Ready to import" : "Imported or optional"}</span><span><strong>Goal</strong>{agenda || "Add an agenda before generating"}</span></div>
            {!generated && <button type="button" className="primary" disabled={!agenda.trim() || !contactId} onClick={async () => { setGenerated(true); await onGenerate(contactId, agenda); }}>Generate 3 private drafts</button>}
            {aiStatus && <p className="status" aria-live="polite">{aiStatus}</p>}
            {generated && !drafts.length && !aiStatus && <p className="status">Cloudflare draft generation is starting…</p>}
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
