"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyRetention } from "@/lib/retention";
import { buildOutcomeSummary, selectRelevantContext, validateContextFile } from "@/lib/retrieval";
import { captureVisibleScreen, extractTextFromImage } from "@/lib/localOcr";
import { generatePrivateDrafts, unloadPrivateModel } from "@/lib/privateAi";
import { PLATFORM_OPTIONS, platformLabel, safePlatformUrl } from "@/lib/platforms";
import { LinkedInTestWizard } from "@/components/LinkedInTestWizard";
import { PwaInstall } from "@/components/PwaInstall";
import {
  createVault,
  eraseVault,
  exportEncryptedBackup,
  importEncryptedBackup,
  parseLegacyWorkspace,
  saveVault,
  unlockVault,
  vaultExists,
  type VaultSession,
} from "@/lib/secureVault";
import {
  createEmptyWorkspace,
  newId,
  type Contact,
  type ConversationPlatform,
  type MessageRole,
  type WorkspaceData,
} from "@/lib/workspaceTypes";

const LEGACY_KEY = "chathelp-private-v2";
const AUTO_LOCK_MS = 15 * 60 * 1000;
const STORAGE_CHECK_TIMEOUT_MS = 8_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Secure browser storage did not respond in time.")), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Something unexpected happened.";
}

export default function ChatHelpApp() {
  const [checking, setChecking] = useState(true);
  const [exists, setExists] = useState(false);
  const [unlocked, setUnlocked] = useState<{ workspace: WorkspaceData; session: VaultSession } | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [startupError, setStartupError] = useState("");
  const [busy, setBusy] = useState(false);
  const [legacy, setLegacy] = useState<WorkspaceData | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const found = await withTimeout(vaultExists(), STORAGE_CHECK_TIMEOUT_MS);
        let legacyWorkspace: WorkspaceData | null = null;
        try {
          legacyWorkspace = parseLegacyWorkspace(localStorage.getItem(LEGACY_KEY));
        } catch {
          // Legacy localStorage is optional. The encrypted IndexedDB vault remains the source of truth.
        }
        if (active) {
          setExists(found);
          setLegacy(legacyWorkspace);
        }
      } catch (caught) {
        if (active) setStartupError(formatError(caught));
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const lock = useCallback(() => {
    void unloadPrivateModel();
    setUnlocked(null);
    setPassphrase("");
    setConfirmation("");
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    let timer = window.setTimeout(lock, AUTO_LOCK_MS);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, AUTO_LOCK_MS);
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "scroll", "touchstart"];
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [lock, unlocked]);

  async function createSecureWorkspace() {
    setError("");
    if (passphrase !== confirmation) return setError("The passphrases do not match.");
    setBusy(true);
    try {
      const result = await createVault(passphrase, legacy ?? createEmptyWorkspace());
      if (legacy) localStorage.removeItem(LEGACY_KEY);
      setUnlocked({ ...result, workspace: applyRetention(result.workspace) });
      setExists(true);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setError("");
    setBusy(true);
    try {
      const result = await unlockVault(passphrase);
      setUnlocked({ ...result, workspace: applyRetention(result.workspace) });
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(file: File) {
    setError("");
    setBusy(true);
    try {
      const result = await importEncryptedBackup(await file.text(), passphrase);
      localStorage.removeItem(LEGACY_KEY);
      setUnlocked({ ...result, workspace: applyRetention(result.workspace) });
      setExists(true);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      if (importRef.current) importRef.current.value = "";
      setBusy(false);
    }
  }

  if (checking) return <main className="vault-shell"><section className="vault-card"><p>Checking this browser for an encrypted workspace…</p></section></main>;
  if (startupError) return <main className="vault-shell"><section className="vault-card" aria-labelledby="storage-error-title"><div className="brand-mark" aria-hidden="true">!</div><p className="eyebrow">SECURE STORAGE UNAVAILABLE</p><h1 id="storage-error-title">ChatHelp could not open the encrypted workspace.</h1><p className="lede">Close other ChatHelp tabs or installed-app windows, confirm this site is allowed to store data, then retry. Your existing encrypted data has not been erased.</p><p className="error" role="alert">{startupError}</p><button className="primary" onClick={() => window.location.reload()}>Retry secure storage</button><p className="fine-print">Do not clear site data if you need an existing vault. If this continues, copy the browser console error for support.</p></section></main>;
  if (unlocked) return <UnlockedWorkspace initial={unlocked.workspace} session={unlocked.session} onLock={lock} />;

  return (
    <main className="vault-shell">
      <section className="vault-card" aria-labelledby="vault-title">
        <div className="brand-mark" aria-hidden="true">CH</div>
        <p className="eyebrow">PRIVATE BY DESIGN</p>
        <h1 id="vault-title">Your conversations stay under your key.</h1>
        <p className="lede">ChatHelp encrypts the workspace in this browser with AES-256-GCM. Your passphrase is never stored, sent, or recoverable by us.</p>
        <div className="trust-grid">
          <span>Encrypted at rest</span><span>AI runs on device</span><span>No platform automation</span>
        </div>
        {legacy && !exists && <div className="notice warning"><strong>Privacy upgrade available.</strong> A plaintext workspace from the earlier version was found. Creating the vault will encrypt it and remove the plaintext copy.</div>}
        <label>Passphrase
          <input type="password" autoComplete={exists ? "current-password" : "new-password"} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={12} placeholder="At least 12 characters" />
        </label>
        {!exists && <label>Confirm passphrase
          <input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} />
        </label>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || passphrase.length < 12 || (!exists && confirmation.length < 12)} onClick={() => void (exists ? unlock() : createSecureWorkspace())}>
          {busy ? "Working…" : exists ? "Unlock private workspace" : "Create encrypted workspace"}
        </button>
        <button className="secondary" disabled={busy || passphrase.length < 12} onClick={() => importRef.current?.click()}>Import encrypted backup</button>
        <input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && void importBackup(event.target.files[0])} />
        <p className="fine-print"><strong>No recovery:</strong> losing the passphrase means losing the data. This is a deliberate privacy property. Use an encrypted backup and a password manager.</p>
          <PwaInstall />
      </section>
    </main>
  );
}

function UnlockedWorkspace({ initial, session, onLock }: { initial: WorkspaceData; session: VaultSession; onLock: () => void }) {
  const [workspace, setWorkspace] = useState(() => applyRetention(initial));
  const [selectedId, setSelectedId] = useState(initial.contacts[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = useState("Encrypted");
  const [newContactName, setNewContactName] = useState("");
  const [newPlatform, setNewPlatform] = useState<ConversationPlatform>("linkedin");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [agenda, setAgenda] = useState("");
  const [drafts, setDrafts] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState("");
  const [appError, setAppError] = useState("");
  const [chatPaste, setChatPaste] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [messageRole, setMessageRole] = useState<MessageRole>("them");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [outcomeResult, setOutcomeResult] = useState<"positive" | "neutral" | "negative">("positive");
  const documentRef = useRef<HTMLInputElement>(null);

  const contact = workspace.contacts.find((item) => item.id === selectedId) ?? workspace.contacts[0] ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSaveStatus("Encrypting…");
      void saveVault(applyRetention(workspace), session).then(() => setSaveStatus("Encrypted"), (error) => {
        setSaveStatus("Save failed");
        setAppError(formatError(error));
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [session, workspace]);

  function updateWorkspace(updater: (current: WorkspaceData) => WorkspaceData) {
    setSaveStatus("Unsaved changes");
    setWorkspace((current) => updater(current));
  }

  function updateContactById(contactId: string, updater: (current: Contact) => Contact) {
    updateWorkspace((current) => ({
      ...current,
      contacts: current.contacts.map((item) => item.id === contactId ? updater(item) : item),
    }));
  }

  function updateContact(updater: (current: Contact) => Contact) {
    if (!contact) return;
    updateContactById(contact.id, updater);
  }

  function saveWizardProfile(profile: { name: string; headline: string; notes: string }): string {
    const existingId = contact?.platform === "linkedin" ? contact.id : "";
    const contactId = existingId || newId("contact");
    const nextContact: Contact = {
      id: contactId,
      name: profile.name.trim() || "LinkedIn contact",
      headline: profile.headline.trim(),
      profileNotes: profile.notes.trim(),
      platform: "linkedin",
      platformUrl: "",
      chat: [],
      documents: [],
      outcomes: [],
      retentionDays: 90,
    };

    updateWorkspace((current) => ({
      ...current,
      contacts: current.contacts.some((item) => item.id === contactId)
        ? current.contacts.map((item) => item.id === contactId ? { ...item, name: nextContact.name, headline: nextContact.headline, profileNotes: nextContact.profileNotes, platform: "linkedin" } : item)
        : [...current.contacts, nextContact],
    }));
    setSelectedId(contactId);
    setDrafts([]);
    return contactId;
  }

  function addContact() {
    const name = newContactName.trim();
    if (!name) return;
    const id = newId("contact");
    const next: Contact = { id, name, headline: "", profileNotes: "", platform: newPlatform, platformUrl: "", chat: [], documents: [], outcomes: [], retentionDays: 90 };
    updateWorkspace((current) => ({ ...current, contacts: [...current.contacts, next] }));
    setSelectedId(id);
    setNewContactName("");
  }

  function deleteContact() {
    if (!contact || !window.confirm("Permanently delete this contact and all of their local context?")) return;
    const remaining = workspace.contacts.filter((item) => item.id !== contact.id);
    updateWorkspace((current) => ({ ...current, contacts: remaining, feedback: current.feedback.filter((item) => item.contactId !== contact.id) }));
    setSelectedId(remaining[0]?.id ?? "");
    setDrafts([]);
  }

  async function downloadBackup() {
    setAppError("");
    try {
      await saveVault(applyRetention(workspace), session);
      const contents = await exportEncryptedBackup();
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "chathelp-encrypted-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) { setAppError(formatError(error)); }
  }

  async function eraseEverything() {
    if (!window.confirm("Erase the encrypted vault from this browser? Export a backup first if you may need it.")) return;
    await eraseVault();
    localStorage.removeItem(LEGACY_KEY);
    onLock();
    window.location.reload();
  }

  async function importDocument(file: File) {
    if (!contact) return;
    const validation = validateContextFile(file);
    if (validation) return setAppError(validation);
    try {
      let text = await file.text();
      if (file.name.toLowerCase().endsWith(".json")) text = JSON.stringify(JSON.parse(text), null, 2);
      updateContact((current) => ({ ...current, documents: [...current.documents, { id: newId("document"), name: file.name, text: text.slice(0, 100_000), createdAt: new Date().toISOString() }] }));
    } catch { setAppError("That context file could not be read safely."); }
    if (documentRef.current) documentRef.current.value = "";
  }

  async function captureContextFor(contactId: string) {
    setAppError("");
    try {
      setAiStatus("Waiting for you to choose a visible window or tab…");
      const image = await captureVisibleScreen();
      const text = await extractTextFromImage(image, setAiStatus);
      if (!text) throw new Error("No readable text was found in the selected screen.");
      updateContactById(contactId, (current) => ({
        ...current,
        documents: [...current.documents, { id: newId("capture"), name: "User-selected screen capture", text: text.slice(0, 100_000), createdAt: new Date().toISOString() }],
      }));
      setAiStatus("Capture processed locally and encrypted.");
    } catch (error) {
      setAiStatus("");
      setAppError(formatError(error));
      throw error;
    }
  }

  async function captureContext() {
    if (!contact) return;
    try { await captureContextFor(contact.id); } catch { /* The user-facing error is already shown. */ }
  }

  function importChatFor(contactId: string, text: string) {
    if (!text.trim()) return;
    const messages = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const mine = /^(me|i):\s*/i.test(line);
      return { id: newId("message"), role: mine ? "me" as const : "them" as const, body: line.replace(/^[^:]{1,40}:\s*/, "").slice(0, 20_000), createdAt: new Date(Date.now() + index).toISOString() };
    });
    updateContactById(contactId, (current) => ({ ...current, chat: [...current.chat, ...messages].slice(-1000) }));
  }

  function importChat() {
    if (!contact || !chatPaste.trim()) return;
    importChatFor(contact.id, chatPaste);
    setChatPaste("");
  }

  function addMessage() {
    if (!contact || !messageBody.trim()) return;
    updateContact((current) => ({ ...current, chat: [...current.chat, { id: newId("message"), role: messageRole, body: messageBody.trim().slice(0, 20_000), createdAt: new Date().toISOString() }] }));
    setMessageBody("");
  }

  async function generate(agendaOverride?: string, contactIdOverride?: string) {
    const activeContact = workspace.contacts.find((item) => item.id === contactIdOverride) ?? contact;
    const requestAgenda = (agendaOverride ?? agenda).trim();
    if (!activeContact || !requestAgenda) return;
    setAppError("");
    setDrafts([]);
    try {
      const query = [requestAgenda, activeContact.profileNotes, activeContact.chat.slice(-8).map((item) => item.body).join(" ")].join(" ");
      const relevant = selectRelevantContext(activeContact.documents, query);
      const feedbackSummary = workspace.feedback.filter((item) => item.contactId === activeContact.id).slice(-20).map((item) => item.rating + ": " + item.note).join("\n");
      const nextDrafts = await generatePrivateDrafts(workspace.modelId, {
        contact: activeContact,
        guidance: workspace.guidance,
        latestQuestion: requestAgenda,
        retrievedContext: relevant,
        feedbackSummary,
        outcomeSummary: buildOutcomeSummary(activeContact),
      }, setAiStatus);
      setDrafts(nextDrafts);
      setAiStatus("Generated locally. Nothing was sent to a message API.");
    } catch (error) {
      setAiStatus("");
      setAppError(formatError(error));
    }
  }

  function rateDraft(draft: string, rating: "useful" | "not-useful") {
    if (!contact) return;
    const note = window.prompt("Optional: what should ChatHelp learn from this draft?", "") ?? "";
    updateWorkspace((current) => ({ ...current, feedback: [...current.feedback, { id: newId("feedback"), contactId: contact.id, draft: draft.slice(0, 2000), rating, note: note.slice(0, 1000), createdAt: new Date().toISOString() }].slice(-1000) }));
  }

  function addOutcome() {
    if (!contact) return;
    updateContact((current) => ({ ...current, outcomes: [...current.outcomes, { id: newId("outcome"), result: outcomeResult, note: outcomeNote.trim().slice(0, 2000), createdAt: new Date().toISOString() }].slice(-200) }));
    setOutcomeNote("");
  }

  const storageSummary = useMemo(() => contact ? contact.chat.length + " messages · " + contact.documents.length + " context files · " + contact.outcomes.length + " outcomes" : "No contact selected", [contact]);
  const handoffUrl = contact ? safePlatformUrl(contact) : null;
  const handoffLabel = contact ? platformLabel(contact.platform) : "platform";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><p className="eyebrow">CHATHELP</p><h1>Private conversation studio</h1></div>
        <div className="top-actions"><button className="wizard-launch" data-testid="open-linkedin-test-wizard" onClick={() => setWizardOpen(true)}>Guided LinkedIn test</button><PwaInstall /><span className="save-state">● {saveStatus}</span><button onClick={() => void downloadBackup()}>Encrypted backup</button><button onClick={onLock}>Lock</button></div>
      </header>
      <div className="privacy-strip"><strong>Private mode:</strong> prompts and generated drafts stay in this browser. Model weights are downloaded from the pinned model host on first use; OCR assets are served by ChatHelp. <button onClick={() => (document.getElementById("privacy-details") as HTMLDialogElement | null)?.showModal()}>Details</button></div>
      {appError && <div className="notice error" role="alert">{appError}<button aria-label="Dismiss" onClick={() => setAppError("")}>×</button></div>}
      <div className="workspace-grid">
        <aside className="contacts-panel">
          <h2>People</h2>
          <div className="contact-create"><select aria-label="Conversation platform" value={newPlatform} onChange={(event) => setNewPlatform(event.target.value as ConversationPlatform)}>{PLATFORM_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><div className="inline-form"><input aria-label="New contact name" value={newContactName} onChange={(event) => setNewContactName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addContact()} placeholder="Add a person" /><button onClick={addContact}>Add</button></div></div>
          <nav aria-label="Contacts">
            {workspace.contacts.map((item) => <button className={item.id === contact?.id ? "contact active" : "contact"} key={item.id} onClick={() => { setSelectedId(item.id); setDrafts([]); }}><span>{item.name.slice(0, 1).toUpperCase()}</span><div><strong>{item.name}</strong><small>{platformLabel(item.platform)} · {item.headline || "Add profile context"}</small></div></button>)}
          </nav>
          {!workspace.contacts.length && <p className="empty">Add one person. ChatHelp never scans your messaging or email accounts.</p>}
        </aside>

        <section className="context-panel">
          {contact ? <>
            <div className="section-heading"><div><p className="eyebrow">SELECTED PERSON</p><h2>{contact.name}</h2><small>{storageSummary}</small></div><button className="danger-link" onClick={deleteContact}>Delete</button></div>
            <div className="panel-card">
              <h3>Profile context</h3>
              <label>Name<input value={contact.name} onChange={(event) => updateContact((current) => ({ ...current, name: event.target.value.slice(0, 200) }))} /></label>
              <label>Headline<input value={contact.headline} onChange={(event) => updateContact((current) => ({ ...current, headline: event.target.value.slice(0, 500) }))} placeholder="Role, company, shared interests" /></label>
              <label>Notes<textarea value={contact.profileNotes} onChange={(event) => updateContact((current) => ({ ...current, profileNotes: event.target.value.slice(0, 20_000) }))} placeholder="Only add what is relevant and appropriate." /></label>
              <div className="button-row"><button onClick={() => void captureContext()}>Capture a screen you choose</button><button onClick={() => documentRef.current?.click()}>Import context file</button><input ref={documentRef} hidden type="file" accept=".txt,.md,.json,text/plain,application/json" onChange={(event) => event.target.files?.[0] && void importDocument(event.target.files[0])} /></div>
              {contact.documents.map((document) => <div className="document-row" key={document.id}><div><strong>{document.name}</strong><small>{document.text.length.toLocaleString()} encrypted characters</small></div><button aria-label={"Delete " + document.name} onClick={() => updateContact((current) => ({ ...current, documents: current.documents.filter((item) => item.id !== document.id) }))}>Remove</button></div>)}
            </div>
            <div className="panel-card">
              <h3>Chat context</h3>
              <textarea value={chatPaste} onChange={(event) => setChatPaste(event.target.value)} placeholder={"Paste selected lines only, for example:\nMe: Great to reconnect\nAlex: Likewise—how is the new role?"} />
              <button onClick={importChat}>Import pasted lines</button>
              <div className="inline-form"><select value={messageRole} onChange={(event) => setMessageRole(event.target.value as MessageRole)}><option value="them">Them</option><option value="me">Me</option></select><input value={messageBody} onChange={(event) => setMessageBody(event.target.value)} placeholder="Add one message" /><button onClick={addMessage}>Add</button></div>
              <div className="chat-list">{contact.chat.slice(-12).map((message) => <div className={message.role === "me" ? "bubble mine" : "bubble"} key={message.id}><small>{message.role === "me" ? "You" : contact.name}</small>{message.body}</div>)}</div>
            </div>
            <div className="panel-card compact">
              <h3>Retention</h3>
              <label>Automatically remove dated context after<select value={contact.retentionDays} onChange={(event) => updateContact((current) => ({ ...current, retentionDays: Number(event.target.value) as Contact["retentionDays"] }))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option><option value={0}>Keep until I delete it</option></select></label>
            </div>
          </> : <div className="empty-state"><div className="brand-mark">1</div><h2>Add a person to begin</h2><p>Only context you deliberately paste, import, or capture will be used.</p><button className="primary" onClick={() => setWizardOpen(true)}>Start guided LinkedIn test</button></div>}
        </section>

        <section className="draft-panel">
          <div className="panel-card guidance-card"><p className="eyebrow">YOUR PLAYBOOK</p><h2>Personal guidance</h2>
            <label>Your role<input value={workspace.guidance.role} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, role: event.target.value } }))} /></label>
            <label>Goal<textarea value={workspace.guidance.objective} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, objective: event.target.value } }))} /></label>
            <label>Voice<input value={workspace.guidance.voice} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, voice: event.target.value } }))} /></label>
            <label>Boundaries<textarea value={workspace.guidance.boundaries} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, boundaries: event.target.value } }))} /></label>
          </div>
          <div className="panel-card compose-card">
            <p className="eyebrow">PRIVATE AI</p><h2>Draft the next reply</h2>
            <label>Question or agenda<textarea value={agenda} onChange={(event) => setAgenda(event.target.value)} placeholder="What did they ask, and what do you want this reply to accomplish?" /></label>
            <label>Local model<select value={workspace.modelId} onChange={(event) => updateWorkspace((current) => ({ ...current, modelId: event.target.value }))}><option value="Llama-3.2-3B-Instruct-q4f16_1-MLC">Llama 3.2 3B · stronger</option><option value="Llama-3.2-1B-Instruct-q4f16_1-MLC">Llama 3.2 1B · lighter</option></select></label>
            <button className="primary" disabled={!contact || !agenda.trim() || Boolean(aiStatus && !aiStatus.includes("Generated") && !aiStatus.includes("Capture processed"))} onClick={() => void generate()}>Generate 3 private drafts</button>
            {aiStatus && <p className="status" aria-live="polite">{aiStatus}</p>}
            <p className="fine-print">First use downloads pinned model weights. Generation then runs in a dedicated browser worker. Review every draft before sending.</p>
          </div>
          <div className="draft-stack">{drafts.map((draft, index) => <article className="draft-card" key={draft + index}><div><span>OPTION {index + 1}</span><div><button onClick={() => void navigator.clipboard.writeText(draft)}>Copy</button><button title="Useful" onClick={() => rateDraft(draft, "useful")}>👍</button><button title="Not useful" onClick={() => rateDraft(draft, "not-useful")}>👎</button></div></div><p>{draft}</p></article>)}</div>
          {contact && <div className="panel-card compact"><h3>Conversation outcome</h3><div className="inline-form"><select value={outcomeResult} onChange={(event) => setOutcomeResult(event.target.value as typeof outcomeResult)}><option value="positive">Positive</option><option value="neutral">Neutral</option><option value="negative">Negative</option></select><input value={outcomeNote} onChange={(event) => setOutcomeNote(event.target.value)} placeholder="What worked or went wrong?" /><button onClick={addOutcome}>Save</button></div></div>}
          {handoffUrl ? <a className="platform-link" href={handoffUrl} target="_blank" rel="noreferrer">Open {handoffLabel} for manual review and paste ↗</a> : <p className="fine-print">Add a valid HTTPS service URL to enable manual handoff.</p>}
        </section>
      </div>
      <footer><span>ChatHelp never sends platform messages or email automatically.</span><button className="danger-link" onClick={() => void eraseEverything()}>Erase all local data</button></footer>
      {wizardOpen && <LinkedInTestWizard
        initialContact={contact}
        guidance={workspace.guidance}
        drafts={drafts}
        aiStatus={aiStatus}
        onClose={() => setWizardOpen(false)}
        onSaveProfile={saveWizardProfile}
        onCapture={captureContextFor}
        onImportChat={importChatFor}
        onGuidanceChange={(field, value) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, [field]: value } }))}
        onGenerate={async (contactId, nextAgenda) => {
          setSelectedId(contactId);
          setAgenda(nextAgenda);
          await generate(nextAgenda, contactId);
        }}
      />}
      <dialog id="privacy-details" className="privacy-dialog"><form method="dialog"><button className="dialog-close" aria-label="Close">×</button><p className="eyebrow">PRIVACY BOUNDARY</p><h2>What leaves this device?</h2><ul><li><strong>Your content:</strong> no chat, profile notes, guidance, outcomes, or drafts are intentionally sent to ChatHelp, any messaging or email platform, or an AI API.</li><li><strong>Model download:</strong> pinned public model files are fetched on first use. The model host sees normal download metadata such as IP address; it does not receive your prompts.</li><li><strong>Screen capture:</strong> the browser asks you to choose a screen. OCR runs locally with self-hosted assets, and only extracted text is encrypted.</li><li><strong>Limits:</strong> browser malware, a compromised origin, or someone who knows your passphrase can still expose data. No software can promise absolute security.</li></ul><button className="primary">Understood</button></form></dialog>
    </main>
  );
}
