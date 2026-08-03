"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyRetention } from "@/lib/retention";
import { buildOutcomeSummary, containsLinkedInPageNoise, isConversationCapture, isLikelyFullLinkedInPageCapture, selectRelevantContext, validateContextFile } from "@/lib/retrieval";
import { captureVisibleScreen, cropImageToRegion, extractTextFromImage, type NormalizedCropRegion } from "@/lib/localOcr";
import { CLOUDFLARE_MODEL_NAME, generatePrivateDrafts } from "@/lib/privateAi";
import { PLATFORM_OPTIONS, platformLabel, safePlatformUrl } from "@/lib/platforms";
import {
  LINKEDIN_EXTENSION_SOURCE,
  LINKEDIN_EXTENSION_STATUS_ACK_EVENT,
  LINKEDIN_EXTENSION_STATUS_EVENT,
  LINKEDIN_SELECTED_CONTACT_EVENT,
  LINKEDIN_SNAPSHOT_ACK_EVENT,
  LINKEDIN_SNAPSHOT_EVENT,
  LINKEDIN_SNAPSHOT_REQUEST_EVENT,
  PIPELINE_STAGES,
  contactStage,
  isActivelySnoozed,
  isCurrentLinkedInExtensionVersion,
  linkedInSelectionForContact,
  isLikelyMobileDevice,
  isReminderDue,
  mergeLinkedInSnapshotForContact,
  parseLinkedInExtensionStatus,
  parseLinkedInExtensionSnapshot,
  recommendLinkedInCaptureMethod,
} from "@/lib/linkedinExtension";
import { LinkedInTestWizard } from "@/components/LinkedInTestWizard";
import { PwaInstall } from "@/components/PwaInstall";
import { ScreenRegionSelector } from "@/components/ScreenRegionSelector";
import {
  createDeviceVault,
  eraseVault,
  getVaultMode,
  migrateLegacyVault,
  openDeviceVault,
  parseLegacyWorkspace,
  saveVault,
  type VaultSession,
} from "@/lib/secureVault";
import {
  CLOUDFLARE_MODEL_ID,
  createEmptyWorkspace,
  newId,
  type Contact,
  type ConversationPlatform,
  type MessageRole,
  type PipelineStage,
  type WorkspaceData,
} from "@/lib/workspaceTypes";

const LEGACY_KEY = "chathelp-private-v2";
const STORAGE_CHECK_TIMEOUT_MS = 8_000;
type InboxView = "inbox" | "pipeline" | "reminders" | "archived";

function toDateTimeLocal(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseLabels(value: string): string[] {
  return Array.from(new Set(value.split(",").map((label) => label.trim().slice(0, 80)).filter(Boolean))).slice(0, 50);
}

function formatRelativeTime(value: string | undefined, now: number): string {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.round((timestamp - now) / 60_000);
  if (Math.abs(minutes) < 1) return "now";
  if (Math.abs(minutes) < 60) return minutes > 0 ? `in ${minutes}m` : `${Math.abs(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return hours > 0 ? `in ${hours}h` : `${Math.abs(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days > 0 ? `in ${days}d` : `${Math.abs(days)}d ago`;
}

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

function hasConversationContext(contact: Contact): boolean {
  return contact.chat.length > 0 || contact.documents.some((document) => isConversationCapture(document) && !isLikelyFullLinkedInPageCapture(document));
}

export default function ChatHelpApp() {
  const [checking, setChecking] = useState(true);
  const [unlocked, setUnlocked] = useState<{ workspace: WorkspaceData; session: VaultSession } | null>(null);
  const [legacyMigrationRequired, setLegacyMigrationRequired] = useState(false);
  const [legacyPassphrase, setLegacyPassphrase] = useState("");
  const [error, setError] = useState("");
  const [startupError, setStartupError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        let legacyWorkspace: WorkspaceData | null = null;
        try {
          legacyWorkspace = parseLegacyWorkspace(localStorage.getItem(LEGACY_KEY));
        } catch {
          // Legacy localStorage is optional. The encrypted IndexedDB vault remains the source of truth.
        }
        const mode = await withTimeout(getVaultMode(), STORAGE_CHECK_TIMEOUT_MS);
        if (mode === "legacy-passphrase") {
          if (active) setLegacyMigrationRequired(true);
          return;
        }
        const result = mode === "device"
          ? await withTimeout(openDeviceVault(), STORAGE_CHECK_TIMEOUT_MS)
          : await withTimeout(createDeviceVault(legacyWorkspace ?? createEmptyWorkspace()), STORAGE_CHECK_TIMEOUT_MS);
        if (legacyWorkspace && mode === "empty") localStorage.removeItem(LEGACY_KEY);
        if (active) setUnlocked({ ...result, workspace: applyRetention(result.workspace) });
      } catch (caught) {
        if (active) setStartupError(formatError(caught));
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; };
  }, []);

  async function migrateExistingWorkspace() {
    setError("");
    setBusy(true);
    try {
      const result = await migrateLegacyVault(legacyPassphrase);
      setUnlocked({ ...result, workspace: applyRetention(result.workspace) });
      setLegacyPassphrase("");
      setLegacyMigrationRequired(false);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function replaceLegacyWorkspace() {
    if (!window.confirm("Erase the old passphrase-protected vault on this browser and start with an empty workspace? This cannot be undone.")) return;
    setBusy(true);
    try {
      await eraseVault();
      const result = await createDeviceVault();
      setUnlocked(result);
      setLegacyMigrationRequired(false);
    } catch (caught) {
      setError(formatError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <main className="vault-shell"><section className="vault-card"><p>Opening this browser&apos;s encrypted workspace…</p></section></main>;
  if (startupError) return <main className="vault-shell"><section className="vault-card" aria-labelledby="storage-error-title"><div className="brand-mark" aria-hidden="true">!</div><p className="eyebrow">SECURE STORAGE UNAVAILABLE</p><h1 id="storage-error-title">ChatHelp could not open the encrypted workspace.</h1><p className="lede">Close other ChatHelp tabs or installed-app windows, confirm this site is allowed to store data, then retry. Your existing encrypted data has not been erased.</p><p className="error" role="alert">{startupError}</p><button className="primary" onClick={() => window.location.reload()}>Retry secure storage</button><p className="fine-print">Do not clear site data if you need an existing vault. If this continues, copy the browser console error for support.</p></section></main>;
  if (unlocked) return <UnlockedWorkspace initial={unlocked.workspace} session={unlocked.session} />;

  if (legacyMigrationRequired) return (
    <main className="vault-shell">
      <section className="vault-card" aria-labelledby="vault-title">
        <div className="brand-mark" aria-hidden="true">CH</div>
        <p className="eyebrow">ONE-TIME PRIVACY UPGRADE</p>
        <h1 id="vault-title">Unlock your existing workspace once.</h1>
        <p className="lede">This browser contains a vault created before Cloudflare email and MFA access was enabled. Enter its old passphrase once to convert it to automatic device encryption. ChatHelp will not ask for it again.</p>
        <label>Existing vault passphrase
          <input type="password" autoComplete="current-password" value={legacyPassphrase} onChange={(event) => setLegacyPassphrase(event.target.value)} minLength={12} placeholder="Your previous ChatHelp passphrase" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy || legacyPassphrase.length < 12} onClick={() => void migrateExistingWorkspace()}>
          {busy ? "Upgrading…" : "Upgrade and continue"}
        </button>
        <button className="secondary" disabled={busy} onClick={() => void replaceLegacyWorkspace()}>Erase old vault and start empty</button>
        <p className="fine-print">New and upgraded workspaces use a non-exportable AES-256 device key stored by this browser. Clearing site data removes the local workspace.</p>
      </section>
    </main>
  );

  return null;
}

function UnlockedWorkspace({ initial, session }: { initial: WorkspaceData; session: VaultSession }) {
  const [workspace, setWorkspace] = useState(() => applyRetention(initial));
  const [selectedId, setSelectedId] = useState(initial.contacts[0]?.id ?? "");
  const [inboxView, setInboxView] = useState<InboxView>("inbox");
  const [contactSearch, setContactSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [extensionStatus, setExtensionStatus] = useState("Chrome extension not connected yet. Load or reload it in Chrome, then refresh ChatHelp. Screen capture remains available under other import options.");
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [extensionIdentityCandidate, setExtensionIdentityCandidate] = useState<{ name: string; profileUrl: string } | null>(null);
  const [captureEnvironment, setCaptureEnvironment] = useState({ detected: false, isMobile: false, supportsScreenCapture: false });
  const [showImportAlternatives, setShowImportAlternatives] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [saveStatus, setSaveStatus] = useState("Encrypted");
  const [newContactName, setNewContactName] = useState("");
  const [newPlatform, setNewPlatform] = useState<ConversationPlatform>("linkedin");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [agenda, setAgenda] = useState("");
  const [drafts, setDrafts] = useState<string[]>(() => initial.contacts[0]?.draftHistory?.at(-1)?.drafts ?? []);
  const [aiStatus, setAiStatus] = useState("");
  const [appError, setAppError] = useState("");
  const [cloudAccessCode, setCloudAccessCode] = useState(() => initial.cloudInference.rememberAccessToken ? initial.cloudInference.accessToken : "");
  const [chatPaste, setChatPaste] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [messageRole, setMessageRole] = useState<MessageRole>("them");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [outcomeResult, setOutcomeResult] = useState<"positive" | "neutral" | "negative">("positive");
  const [cropRequest, setCropRequest] = useState<{
    image: Blob;
    contactName: string;
    purpose: "profile" | "chat";
    resolve: (region: NormalizedCropRegion | null) => void;
  } | null>(null);
  const documentRef = useRef<HTMLInputElement>(null);
  const chatPasteRef = useRef<HTMLTextAreaElement>(null);
  const agendaRef = useRef<HTMLTextAreaElement>(null);
  const snoozeRef = useRef<HTMLInputElement>(null);
  const labelsRef = useRef<HTMLInputElement>(null);
  const shortcutDialogRef = useRef<HTMLDialogElement>(null);
  const workspaceRef = useRef(workspace);
  const selectedIdRef = useRef(selectedId);
  const extensionConnectedRef = useRef(false);
  const extensionVersionRef = useRef("");
  const shortcutSequenceRef = useRef("");

  const contact = workspace.contacts.find((item) => item.id === selectedId) ?? workspace.contacts[0] ?? null;
  const selectedContactName = contact?.name ?? "";
  const selectedContactProfileUrl = contact?.profileUrl ?? "";
  const selectedContactPlatform = contact?.platform ?? "";

  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    const capabilityTimer = window.setTimeout(() => {
      setCaptureEnvironment({
        detected: true,
        isMobile: isLikelyMobileDevice(navigator.userAgent, navigator.maxTouchPoints),
        supportsScreenCapture: Boolean(navigator.mediaDevices?.getDisplayMedia),
      });
    }, 0);
    const targetOrigin = window.location.origin === "null" ? "*" : window.location.origin;
    const handleSnapshot = (event: MessageEvent) => {
      if (event.source !== window || (window.location.origin !== "null" && event.origin !== window.location.origin)) return;
      const data = event.data as { source?: unknown; type?: unknown; payload?: unknown; version?: unknown } | null;
      if (!data || data.source !== LINKEDIN_EXTENSION_SOURCE) return;
      if (data.type === "CHATHELP_EXTENSION_READY") {
        extensionConnectedRef.current = true;
        const version = typeof data.version === "string" ? data.version : "";
        extensionVersionRef.current = version;
        const currentVersion = isCurrentLinkedInExtensionVersion(version);
        setExtensionConnected(currentVersion);
        const selected = workspaceRef.current.contacts.find((item) => item.id === selectedIdRef.current);
        const selection = linkedInSelectionForContact(selected);
        setExtensionStatus(currentVersion
          ? selection ? `Chrome extension ${version} connected and locked to ${selection.name}. It will refuse to read a different conversation.` : `Chrome extension ${version} connected. Add and select a LinkedIn contact before capturing messages.`
          : `An older ChatHelp extension${version ? ` (${version})` : ""} is installed. In chrome://extensions, reload the current ChatHelp extension folder, then reload this tab.`);
        window.postMessage({ source: "chathelp-app", type: LINKEDIN_SELECTED_CONTACT_EVENT, contact: selection }, targetOrigin);
        return;
      }
      if (data.type === LINKEDIN_EXTENSION_STATUS_EVENT) {
        const status = parseLinkedInExtensionStatus(data.payload);
        if (!status) return;
        extensionConnectedRef.current = true;
        if (isCurrentLinkedInExtensionVersion(extensionVersionRef.current)) setExtensionConnected(true);
        setExtensionStatus(status.message);
        setExtensionIdentityCandidate(status.code === "contact_mismatch" ? status.observedContact : null);
        window.postMessage({ source: "chathelp-app", type: LINKEDIN_EXTENSION_STATUS_ACK_EVENT, statusId: status.statusId }, targetOrigin);
        return;
      }
      if (data.type !== LINKEDIN_SNAPSHOT_EVENT) return;
      const snapshot = parseLinkedInExtensionSnapshot(data.payload);
      if (!snapshot) {
        setExtensionStatus("The extension capture was rejected because it was incomplete or unsafe.");
        return;
      }
      extensionConnectedRef.current = true;
      setExtensionConnected(true);
      setExtensionIdentityCandidate(null);
      const selectedContactId = selectedIdRef.current;
      const selected = workspaceRef.current.contacts.find((item) => item.id === selectedContactId);
      const preview = mergeLinkedInSnapshotForContact(workspaceRef.current.contacts, selectedContactId, snapshot);
      if (!preview) {
        const expectedName = selected?.name || "the selected ChatHelp contact";
        setExtensionStatus(`Capture blocked and discarded. The open LinkedIn conversation is not ${expectedName}. Select ${expectedName} in ChatHelp, then open that same conversation before clicking the extension.`);
        window.postMessage({ source: "chathelp-app", type: LINKEDIN_SNAPSHOT_ACK_EVENT, captureId: snapshot.captureId }, targetOrigin);
        return;
      }
      setWorkspace((current) => {
        const merged = mergeLinkedInSnapshotForContact(current.contacts, selectedContactId, snapshot);
        return merged ? { ...current, contacts: merged.contacts } : current;
      });
      setInboxView("inbox");
      setExtensionStatus(`${selected?.name || snapshot.contact.name} imported: ${preview.importedMessages} new visible message${preview.importedMessages === 1 ? "" : "s"}. The extension read only the selected contact's open conversation.`);
      window.postMessage({ source: "chathelp-app", type: LINKEDIN_SNAPSHOT_ACK_EVENT, captureId: snapshot.captureId }, targetOrigin);
    };
    window.addEventListener("message", handleSnapshot);
    window.postMessage({ source: "chathelp-app", type: LINKEDIN_SNAPSHOT_REQUEST_EVENT }, targetOrigin);
    const extensionTimer = window.setTimeout(() => {
      if (!extensionConnectedRef.current) setExtensionStatus("No extension bridge was detected on this ChatHelp tab. Open ChatHelp in regular desktop Chrome, reload the ChatHelp extension in chrome://extensions, allow site access for this app, then reload this tab.");
    }, 2_500);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(capabilityTimer);
      window.clearTimeout(extensionTimer);
      window.removeEventListener("message", handleSnapshot);
    };
  }, []);

  useEffect(() => {
    const targetOrigin = window.location.origin === "null" ? "*" : window.location.origin;
    const selected = workspaceRef.current.contacts.find((item) => item.id === selectedIdRef.current);
    const selection = linkedInSelectionForContact(selected);
    window.postMessage({ source: "chathelp-app", type: LINKEDIN_SELECTED_CONTACT_EVENT, contact: selection }, targetOrigin);
  }, [selectedId, selectedContactName, selectedContactProfileUrl, selectedContactPlatform]);

  useEffect(() => {
    if (!extensionConnectedRef.current) return;
    const selected = workspaceRef.current.contacts.find((item) => item.id === selectedIdRef.current);
    const selection = linkedInSelectionForContact(selected);
    setExtensionIdentityCandidate(null);
    const version = extensionVersionRef.current;
    setExtensionStatus(isCurrentLinkedInExtensionVersion(version)
      ? selection ? `Chrome extension ${version} connected and locked to ${selection.name}. It will refuse to read a different conversation.` : `Chrome extension ${version} connected. Add and select a LinkedIn contact before capturing messages.`
      : `An older ChatHelp extension${version ? ` (${version})` : ""} is installed. In chrome://extensions, reload the current ChatHelp extension folder, then reload this tab.`);
  }, [selectedId, selectedContactName, selectedContactPlatform]);

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

  function setActiveContactId(contactId: string) {
    selectedIdRef.current = contactId;
    setSelectedId(contactId);
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

  function confirmObservedLinkedInIdentity() {
    if (!contact || !extensionIdentityCandidate) return;
    const observed = extensionIdentityCandidate;
    updateContact((current) => ({
      ...current,
      name: observed.name,
      profileUrl: observed.profileUrl || current.profileUrl,
    }));
    setExtensionIdentityCandidate(null);
    setExtensionStatus(`${observed.name} is now linked to this ChatHelp contact. Return to that open LinkedIn conversation and click the ChatHelp extension once more to capture its visible messages.`);
  }

  function selectContact(nextContact: Contact) {
    setActiveContactId(nextContact.id);
    setDrafts(nextContact.draftHistory?.at(-1)?.drafts ?? []);
    setShowImportAlternatives(false);
  }

  function moveContactToStage(contactId: string, stage: PipelineStage) {
    updateContactById(contactId, (current) => ({ ...current, pipelineStage: stage }));
  }

  function toggleArchive(target: Contact) {
    updateContactById(target.id, (current) => ({
      ...current,
      archivedAt: current.archivedAt ? "" : new Date().toISOString(),
      pipelineStage: current.archivedAt ? "inbox" : "done",
    }));
  }

  function persistDrafts(nextDrafts = drafts) {
    if (!contact?.draftHistory?.length) return;
    updateContact((current) => ({
      ...current,
      draftHistory: (current.draftHistory ?? []).map((entry, index, entries) => index === entries.length - 1 ? { ...entry, drafts: nextDrafts } : entry),
    }));
  }

  function markDraftManuallySent(draft: string) {
    if (!contact || !draft.trim()) return;
    const sentAt = new Date().toISOString();
    updateContact((current) => ({
      ...current,
      chat: [...current.chat, { id: newId("message"), role: "me" as const, body: draft.trim().slice(0, 20_000), createdAt: sentAt, speaker: "You", attachments: [] }].slice(-1000),
      pipelineStage: "replied",
      snoozedUntil: "",
      followUpAt: "",
    }));
    setExtensionStatus(`Marked as manually sent to ${contact.name}. ChatHelp did not type or send anything on LinkedIn.`);
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
      profileUrl: "",
      avatarUrl: "",
      conversationUrl: "",
      labels: [],
      pipelineStage: "inbox",
      notes: "",
      snoozedUntil: "",
      followUpAt: "",
      archivedAt: "",
      lastSyncedAt: "",
      draftHistory: [],
    };

    updateWorkspace((current) => ({
      ...current,
      contacts: current.contacts.some((item) => item.id === contactId)
        ? current.contacts.map((item) => item.id === contactId ? { ...item, name: nextContact.name, headline: nextContact.headline, profileNotes: nextContact.profileNotes, platform: "linkedin" } : item)
        : [...current.contacts, nextContact],
    }));
    setActiveContactId(contactId);
    setDrafts([]);
    return contactId;
  }

  function addContact() {
    const name = newContactName.trim();
    if (!name) return;
    const id = newId("contact");
    const next: Contact = { id, name, headline: "", profileNotes: "", platform: newPlatform, platformUrl: "", chat: [], documents: [], outcomes: [], retentionDays: 90, profileUrl: "", avatarUrl: "", conversationUrl: "", labels: [], pipelineStage: "inbox", notes: "", snoozedUntil: "", followUpAt: "", archivedAt: "", lastSyncedAt: "", draftHistory: [] };
    updateWorkspace((current) => ({ ...current, contacts: [...current.contacts, next] }));
    setActiveContactId(id);
    setNewContactName("");
  }

  function deleteContact() {
    if (!contact || !window.confirm("Permanently delete this contact and all of their local context?")) return;
    const remaining = workspace.contacts.filter((item) => item.id !== contact.id);
    updateWorkspace((current) => ({ ...current, contacts: remaining, feedback: current.feedback.filter((item) => item.contactId !== contact.id) }));
    setActiveContactId(remaining[0]?.id ?? "");
    setDrafts([]);
  }

  async function eraseEverything() {
    if (!window.confirm("Erase the encrypted workspace and device key from this browser? This cannot be undone.")) return;
    await eraseVault();
    localStorage.removeItem(LEGACY_KEY);
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

  async function captureContextFor(contactId: string, purpose: "profile" | "chat") {
    setAppError("");
    const target = workspace.contacts.find((item) => item.id === contactId);
    const targetName = target?.name || "the selected contact";
    try {
      setAiStatus(purpose === "profile"
        ? `Choose the LinkedIn profile tab for ${targetName} in the system picker…`
        : `Choose the LinkedIn Messaging tab showing your conversation with ${targetName}…`);
      const image = await captureVisibleScreen();
      setAiStatus(`Select only ${purpose === "chat" ? `${targetName}'s message column` : `${targetName}'s profile details`} for local OCR…`);
      const region = await new Promise<NormalizedCropRegion | null>((resolve) => setCropRequest({ image, contactName: targetName, purpose, resolve }));
      if (!region) {
        setAiStatus("");
        return;
      }
      setAiStatus("Cropping the selected area locally…");
      const croppedImage = await cropImageToRegion(image, region);
      const text = await extractTextFromImage(croppedImage, setAiStatus);
      if (!text) throw new Error("No readable text was found in the selected screen.");
      if (containsLinkedInPageNoise(text)) throw new Error(`That area still includes LinkedIn navigation, other conversations, or job suggestions. Capture again and select only ${purpose === "chat" ? `${targetName}'s central message column` : `${targetName}'s main profile details`}.`);
      updateContactById(contactId, (current) => ({
        ...current,
        documents: [...current.documents, {
          id: newId("capture"),
          name: purpose === "profile" ? `LinkedIn profile screen for ${current.name}` : `LinkedIn conversation screen with ${current.name}`,
          text: text.slice(0, 100_000),
          createdAt: new Date().toISOString(),
        }],
      }));
      setAiStatus(purpose === "profile"
        ? `Profile screen for ${targetName} processed locally and encrypted.`
        : `Conversation screen with ${targetName} processed locally and encrypted.`);
    } catch (error) {
      setAiStatus("");
      setAppError(formatError(error));
      throw error;
    }
  }

  async function captureContext() {
    if (!contact) return;
    try { await captureContextFor(contact.id, "profile"); } catch { /* The user-facing error is already shown. */ }
  }

  async function captureConversation() {
    if (!contact) return;
    try { await captureContextFor(contact.id, "chat"); } catch { /* The user-facing error is already shown. */ }
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
    if (!hasConversationContext(activeContact)) {
      const rejectedFullPage = activeContact.documents.some((document) => isConversationCapture(document) && isLikelyFullLinkedInPageCapture(document));
      setAppError(rejectedFullPage
        ? `The saved capture for ${activeContact.name} contains LinkedIn navigation, other chats, or job suggestions, so ChatHelp will not send it to AI. Remove it and capture only the central message column.`
        : `Add recent chat history with ${activeContact.name} before generating. Capture only the LinkedIn message area or add at least one message.`);
      return;
    }
    setAppError("");
    setDrafts([]);
    try {
      const query = [requestAgenda, activeContact.profileNotes, activeContact.chat.slice(-8).map((item) => item.body).join(" ")].join(" ");
      const relevant = selectRelevantContext(activeContact.documents.filter((document) => !isConversationCapture(document) && !isLikelyFullLinkedInPageCapture(document)), query);
      const feedbackSummary = workspace.feedback.filter((item) => item.contactId === activeContact.id).slice(-20).map((item) => item.rating + ": " + item.note).join("\n");
      const nextDrafts = await generatePrivateDrafts(CLOUDFLARE_MODEL_ID, {
        contact: activeContact,
        guidance: workspace.guidance,
        latestQuestion: requestAgenda,
        retrievedContext: relevant,
        feedbackSummary,
        outcomeSummary: buildOutcomeSummary(activeContact),
      }, setAiStatus, { ...workspace.cloudInference, accessToken: cloudAccessCode });
      setDrafts(nextDrafts);
      const generatedAt = new Date().toISOString();
      updateWorkspace((current) => ({
        ...current,
        contacts: current.contacts.map((item) => item.id === activeContact.id ? {
          ...item,
          draftHistory: [...(item.draftHistory ?? []), { id: newId("draft-set"), agenda: requestAgenda.slice(0, 5_000), drafts: nextDrafts, createdAt: generatedAt }].slice(-20),
        } : item),
        aiUsage: [...(current.aiUsage ?? []), {
          id: newId("ai-usage"),
          contactId: activeContact.id,
          modelId: CLOUDFLARE_MODEL_ID,
          promptCharacters: requestAgenda.length + activeContact.profileNotes.length + activeContact.chat.slice(-40).reduce((total, message) => total + message.body.length, 0),
          variants: nextDrafts.length,
          estimatedCostUsd: 0,
          createdAt: generatedAt,
        }].slice(-1000),
      }));
      setAiStatus("Generated in Cloudflare Workers AI. No LLM was downloaded or run on this device, and nothing was sent to LinkedIn.");
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

  const allLabels = useMemo(() => Array.from(new Set(workspace.contacts.flatMap((item) => item.labels ?? []))).sort((left, right) => left.localeCompare(right)), [workspace.contacts]);
  const dueReminderCount = useMemo(() => workspace.contacts.filter((item) => !item.archivedAt && isReminderDue(item, now)).length, [now, workspace.contacts]);
  const visibleContacts = useMemo(() => {
    const query = contactSearch.trim().toLowerCase();
    return workspace.contacts.filter((item) => {
      if (inboxView === "archived" ? !item.archivedAt : Boolean(item.archivedAt)) return false;
      if (inboxView === "inbox" && isActivelySnoozed(item, now)) return false;
      if (inboxView === "reminders" && !item.followUpAt && !item.snoozedUntil) return false;
      if (labelFilter && !(item.labels ?? []).includes(labelFilter)) return false;
      if (!query) return true;
      const latest = item.chat.at(-1)?.body ?? "";
      return [item.name, item.headline, item.notes ?? "", (item.labels ?? []).join(" "), latest].join(" ").toLowerCase().includes(query);
    }).sort((left, right) => {
      if (inboxView === "reminders") {
        const leftDate = Math.min(...[left.followUpAt, left.snoozedUntil].filter(Boolean).map((value) => new Date(value as string).getTime()));
        const rightDate = Math.min(...[right.followUpAt, right.snoozedUntil].filter(Boolean).map((value) => new Date(value as string).getTime()));
        return leftDate - rightDate;
      }
      return new Date(right.chat.at(-1)?.createdAt ?? right.lastSyncedAt ?? 0).getTime() - new Date(left.chat.at(-1)?.createdAt ?? left.lastSyncedAt ?? 0).getTime();
    });
  }, [contactSearch, inboxView, labelFilter, now, workspace.contacts]);
  const stageCounts = useMemo(() => Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage.value, workspace.contacts.filter((item) => !item.archivedAt && contactStage(item) === stage.value).length])) as Record<PipelineStage, number>, [workspace.contacts]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (event.key === "?") {
        event.preventDefault();
        shortcutDialogRef.current?.showModal();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "j") {
        event.preventDefault();
        agendaRef.current?.focus();
        return;
      }
      if (key === "g") {
        shortcutSequenceRef.current = "g";
        return;
      }
      if (key === "i" && shortcutSequenceRef.current === "g") {
        event.preventDefault();
        setInboxView("inbox");
        shortcutSequenceRef.current = "";
        return;
      }
      shortcutSequenceRef.current = "";
      if ((key === "j" || key === "k") && visibleContacts.length) {
        event.preventDefault();
        const currentIndex = Math.max(0, visibleContacts.findIndex((item) => item.id === contact?.id));
        const nextIndex = key === "j" ? Math.min(visibleContacts.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
        const nextContact = visibleContacts[nextIndex];
        setActiveContactId(nextContact.id);
        setDrafts(nextContact.draftHistory?.at(-1)?.drafts ?? []);
      } else if (key === "e" && contact) {
        event.preventDefault();
        setWorkspace((current) => ({ ...current, contacts: current.contacts.map((item) => item.id === contact.id ? { ...item, archivedAt: item.archivedAt ? "" : new Date().toISOString(), pipelineStage: item.archivedAt ? "inbox" : "done" } : item) }));
      } else if (key === "r") {
        event.preventDefault();
        agendaRef.current?.focus();
      } else if (key === "s") {
        event.preventDefault();
        snoozeRef.current?.focus();
      } else if (key === "l") {
        event.preventDefault();
        labelsRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [contact, visibleContacts]);

  const storageSummary = useMemo(() => contact ? contact.chat.length + " messages · " + contact.documents.length + " context files · " + contact.outcomes.length + " outcomes · " + (contact.draftHistory?.length ?? 0) + " draft sets" : "No contact selected", [contact]);
  const handoffUrl = contact ? safePlatformUrl(contact) : null;
  const handoffLabel = contact ? platformLabel(contact.platform) : "platform";
  const cloudReady = Boolean(workspace.cloudInference.consentedAt && cloudAccessCode.trim().length >= 20);
  const conversationReady = Boolean(contact && hasConversationContext(contact));
  const captureMethod = recommendLinkedInCaptureMethod({
    detected: captureEnvironment.detected,
    extensionConnected,
    isMobile: captureEnvironment.isMobile,
    supportsScreenCapture: captureEnvironment.supportsScreenCapture,
  });

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><p className="eyebrow">CHATHELP</p><h1>Private conversation studio</h1></div>
        <div className="top-actions">{dueReminderCount > 0 && <button className="reminder-badge" onClick={() => setInboxView("reminders")}>{dueReminderCount} reminder{dueReminderCount === 1 ? "" : "s"} due</button>}<button onClick={() => shortcutDialogRef.current?.showModal()} aria-label="Show keyboard shortcuts">Shortcuts</button><button className="wizard-launch" data-testid="open-linkedin-test-wizard" onClick={() => setWizardOpen(true)}>Guided LinkedIn test</button><PwaInstall /><span className="save-state">● {saveStatus} on this device</span></div>
      </header>
      <div className="privacy-strip"><strong>Manual-safe {captureEnvironment.isMobile ? "mobile" : "desktop"} mode:</strong> {captureEnvironment.isMobile ? "ChatHelp recommends manual paste or import on this device." : "The Chrome extension is the primary desktop reader and is locked to the contact selected in ChatHelp."} It never scans the inbox, clicks, types, or sends on LinkedIn. Imported text stays in this device vault; only selected text context is sent to Cloudflare Workers AI when you request drafts. <button onClick={() => (document.getElementById("privacy-details") as HTMLDialogElement | null)?.showModal()}>Details</button></div>
      {appError && <div className="notice error" role="alert">{appError}<button aria-label="Dismiss" onClick={() => setAppError("")}>×</button></div>}
      <div className={inboxView === "pipeline" ? "workspace-grid pipeline-active" : "workspace-grid"}>
        <aside className="contacts-panel">
          <div className="section-heading"><div><p className="eyebrow">DESKTOP WORKSPACE</p><h2>LinkedIn inbox</h2></div><button aria-label="Show keyboard shortcuts" onClick={() => shortcutDialogRef.current?.showModal()}>?</button></div>
          <div className="inbox-tabs" role="tablist" aria-label="Conversation views">
            <button role="tab" aria-selected={inboxView === "inbox"} onClick={() => setInboxView("inbox")}>Inbox <span>{workspace.contacts.filter((item) => !item.archivedAt && !isActivelySnoozed(item, now)).length}</span></button>
            <button role="tab" aria-selected={inboxView === "pipeline"} onClick={() => setInboxView("pipeline")}>Pipeline</button>
            <button role="tab" aria-selected={inboxView === "reminders"} onClick={() => setInboxView("reminders")}>Reminders <span>{dueReminderCount}</span></button>
            <button role="tab" aria-selected={inboxView === "archived"} onClick={() => setInboxView("archived")}>Archive</button>
          </div>
          <div className="inbox-filters"><input aria-label="Search contacts and messages" value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Search contacts or messages" /><select aria-label="Filter by label" value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}><option value="">All labels</option>{allLabels.map((label) => <option key={label} value={label}>{label}</option>)}</select></div>
          <div className="contact-create"><small>Add a contact manually</small><select aria-label="Conversation platform" value={newPlatform} onChange={(event) => setNewPlatform(event.target.value as ConversationPlatform)}>{PLATFORM_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><div className="inline-form"><input aria-label="New contact name" value={newContactName} onChange={(event) => setNewContactName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addContact()} placeholder="Add a person" /><button onClick={addContact}>Add</button></div></div>
          <nav aria-label="Contacts">
            {visibleContacts.map((item) => {
              const latest = item.chat.at(-1);
              const reminderAt = item.followUpAt || item.snoozedUntil;
              return <button className={item.id === contact?.id ? "contact active" : "contact"} key={item.id} onClick={() => selectContact(item)}>
                {item.avatarUrl ? <img src={item.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <span className="contact-avatar">{item.name.slice(0, 1).toUpperCase()}</span>}
                <div><span className="contact-title"><strong>{item.name}</strong><small className={`stage-pill stage-${contactStage(item)}`}>{PIPELINE_STAGES.find((stage) => stage.value === contactStage(item))?.label}</small></span><small>{latest?.body || item.headline || "No conversation imported yet"}</small><span className="contact-meta"><small>{latest ? formatRelativeTime(latest.createdAt, now) : platformLabel(item.platform)}</small>{reminderAt && <small className={isReminderDue(item, now) ? "reminder-due" : ""}>{isReminderDue(item, now) ? "Due " : ""}{formatRelativeTime(reminderAt, now)}</small>}</span>{Boolean(item.labels?.length) && <span className="label-row">{item.labels?.slice(0, 3).map((label) => <small key={label} className="label-chip">{label}</small>)}</span>}</div>
              </button>;
            })}
          </nav>
          {!visibleContacts.length && <p className="empty">No conversations match this view. ChatHelp never scans LinkedIn in the background.</p>}
        </aside>

        <section className="context-panel">
          {inboxView === "pipeline" ? <div className="pipeline-view">
            <div className="section-heading"><div><p className="eyebrow">LOCAL CRM VIEW</p><h2>Conversation pipeline</h2><p className="identity-note">Drag cards between stages or use each stage menu. This changes only your local ChatHelp workspace and never touches LinkedIn.</p></div></div>
            <div className="pipeline-board">
              {PIPELINE_STAGES.map((stage) => <section className="pipeline-column" key={stage.value} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                event.preventDefault();
                const contactId = event.dataTransfer.getData("text/contact-id");
                if (contactId) moveContactToStage(contactId, stage.value);
              }}>
                <header><strong>{stage.label}</strong><span>{stageCounts[stage.value]}</span></header>
                <div>{visibleContacts.filter((item) => contactStage(item) === stage.value).map((item) => <article className={item.id === contact?.id ? "pipeline-card selected" : "pipeline-card"} draggable key={item.id} onDragStart={(event) => event.dataTransfer.setData("text/contact-id", item.id)} onClick={() => selectContact(item)}>
                  <div><strong>{item.name}</strong><small>{formatRelativeTime(item.chat.at(-1)?.createdAt ?? item.lastSyncedAt, now)}</small></div>
                  <p>{item.chat.at(-1)?.body || item.headline || "No message preview"}</p>
                  <select aria-label={`Move ${item.name} to pipeline stage`} value={contactStage(item)} onClick={(event) => event.stopPropagation()} onChange={(event) => moveContactToStage(item.id, event.target.value as PipelineStage)}>{PIPELINE_STAGES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                  {Boolean(item.labels?.length) && <span className="label-row">{item.labels?.slice(0, 3).map((label) => <small className="label-chip" key={label}>{label}</small>)}</span>}
                </article>)}</div>
              </section>)}
            </div>
          </div> : contact ? <>
            <div className="section-heading"><div><p className="eyebrow">SELECTED LINKEDIN CONTACT · MESSAGE RECIPIENT</p><h2>{contact.name}</h2><p className="identity-note">Profile context, chat history, and generated replies in this workspace are for your conversation with <strong>{contact.name}</strong>.</p><small>{storageSummary}{contact.lastSyncedAt ? ` · extension sync ${formatRelativeTime(contact.lastSyncedAt, now)}` : ""}</small></div><button className="danger-link" onClick={deleteContact}>Delete</button></div>
            <div className="panel-card workflow-card">
              <div className="workflow-title"><div><p className="eyebrow">TRIAGE & FOLLOW-UP</p><h3>Conversation workflow</h3></div><button onClick={() => toggleArchive(contact)}>{contact.archivedAt ? "Restore to inbox" : "Archive"}</button></div>
              <div className="workflow-grid">
                <label>Pipeline stage<select aria-label={`Pipeline stage for ${contact.name}`} value={contactStage(contact)} onChange={(event) => moveContactToStage(contact.id, event.target.value as PipelineStage)}>{PIPELINE_STAGES.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></label>
                <label>Labels<input key={contact.id} ref={labelsRef} defaultValue={(contact.labels ?? []).join(", ")} onBlur={(event) => updateContact((current) => ({ ...current, labels: parseLabels(event.target.value) }))} placeholder="candidate, warm lead, client" /></label>
                <label>Snooze until<input ref={snoozeRef} type="datetime-local" value={toDateTimeLocal(contact.snoozedUntil)} onChange={(event) => updateContact((current) => ({ ...current, snoozedUntil: fromDateTimeLocal(event.target.value), pipelineStage: event.target.value ? "snoozed" : contactStage(current) }))} /></label>
                <label>Follow-up reminder<input type="datetime-local" value={toDateTimeLocal(contact.followUpAt)} onChange={(event) => updateContact((current) => ({ ...current, followUpAt: fromDateTimeLocal(event.target.value), pipelineStage: event.target.value ? "follow-up" : contactStage(current) }))} /></label>
              </div>
              {(contact.snoozedUntil || contact.followUpAt) && <div className="reminder-summary"><span>{contact.snoozedUntil && `Snoozed ${formatRelativeTime(contact.snoozedUntil, now)}`}{contact.snoozedUntil && contact.followUpAt ? " · " : ""}{contact.followUpAt && `Follow-up ${formatRelativeTime(contact.followUpAt, now)}`}</span><button onClick={() => updateContact((current) => ({ ...current, snoozedUntil: "", followUpAt: "", pipelineStage: contactStage(current) === "snoozed" || contactStage(current) === "follow-up" ? "inbox" : contactStage(current) }))}>Clear schedule</button></div>}
              <label>Private conversation notes<textarea value={contact.notes ?? ""} onChange={(event) => updateContact((current) => ({ ...current, notes: event.target.value.slice(0, 20_000) }))} placeholder={`Decisions, next steps, and private notes about the conversation with ${contact.name}.`} /></label>
            </div>
            <div className="panel-card">
              <h3>{contact.name}&apos;s LinkedIn profile</h3>
              <p className="section-explainer">This section is about the selected contact—not your own profile. Use only details relevant to this conversation.</p>
              <label>Contact&apos;s name<input value={contact.name} onChange={(event) => updateContact((current) => ({ ...current, name: event.target.value.slice(0, 200) }))} /></label>
              <label>Contact&apos;s headline, role, or company<input value={contact.headline} onChange={(event) => updateContact((current) => ({ ...current, headline: event.target.value.slice(0, 500) }))} placeholder={`Example: ${contact.name}'s role, company, or relevant expertise`} /></label>
              {contact.profileUrl && <a className="profile-link" href={contact.profileUrl} target="_blank" rel="noreferrer">Open {contact.name}&apos;s LinkedIn profile ↗</a>}
              <label>Relevant notes about {contact.name}<textarea value={contact.profileNotes} onChange={(event) => updateContact((current) => ({ ...current, profileNotes: event.target.value.slice(0, 20_000) }))} placeholder={`Only add relevant, non-sensitive context about ${contact.name}.`} /></label>
              <input ref={documentRef} hidden type="file" accept=".txt,.md,.json,text/plain,application/json" onChange={(event) => event.target.files?.[0] && void importDocument(event.target.files[0])} />
              {contact.documents.filter((document) => !isConversationCapture(document)).map((document) => <div className="document-row" key={document.id}><div><strong>{document.name}</strong><small>{isLikelyFullLinkedInPageCapture(document) ? "Not used by AI — full LinkedIn page detected" : `${document.text.length.toLocaleString()} encrypted characters`}</small></div><button aria-label={"Delete " + document.name} onClick={() => updateContact((current) => ({ ...current, documents: current.documents.filter((item) => item.id !== document.id) }))}>Remove</button></div>)}
            </div>
            <div className="panel-card">
              <h3>Your conversation with {contact.name}</h3>
              <p className="section-explainer"><strong>You</strong> means the person using ChatHelp. <strong>{contact.name}</strong> is the selected LinkedIn contact who will receive your reply.</p>
              <div className={`capture-recommendation capture-${captureMethod}`} data-testid="recommended-linkedin-import">
                <div className="capture-recommendation-copy">
                  <span className="capture-method-label">Recommended for this device</span>
                  {captureMethod === "detecting" && <><h4>Choosing the safest import method…</h4><p>ChatHelp is checking this browser&apos;s local capabilities. No LinkedIn data is being read.</p></>}
                  {captureMethod === "extension" && <><h4>{extensionConnected ? "Chrome extension connected" : "Chrome extension recommended for this desktop"}</h4><p>Select {contact.name} in ChatHelp, open that same contact&apos;s LinkedIn conversation, and click the ChatHelp extension icon. Before reading any messages, the extension verifies the open conversation matches {contact.name}. A different contact is blocked.</p></>}
                  {captureMethod === "screen" && <><h4>Screen capture recommended for this desktop</h4><p>Choose the LinkedIn Messaging tab or window, then select only the central message column in ChatHelp&apos;s private preview. Navigation, other chats, job cards, and side panels are excluded.</p></>}
                  {captureMethod === "manual" && <><h4>Paste or import recommended on this device</h4><p>{captureEnvironment.isMobile ? "Mobile browsers do not provide the safe desktop capture flow. Copy only the relevant LinkedIn messages and paste them below." : "This browser does not provide a compatible screen-capture or extension connection. Copy only the relevant LinkedIn messages and paste them below."}</p></>}
                </div>
                <div className="capture-primary-action">
                  {captureMethod === "detecting" && <button disabled>Choosing best method…</button>}
                  {captureMethod === "extension" && <a className="capture-action" href={handoffUrl ?? "https://www.linkedin.com/messaging/"} target="_blank" rel="noreferrer">Open {contact.name}&apos;s LinkedIn conversation</a>}
                  {captureMethod === "screen" && <button onClick={() => void captureConversation()}>Capture conversation screen</button>}
                  {captureMethod === "manual" && <button onClick={() => chatPasteRef.current?.focus()}>Paste messages manually</button>}
                </div>
                {captureMethod === "extension" && <small role="status" aria-live="polite">{extensionStatus}</small>}
                {captureMethod === "extension" && extensionIdentityCandidate && <div className="extension-identity-confirmation" role="alert">
                  <p>The extension found <strong>{extensionIdentityCandidate.name}</strong> in the open LinkedIn header but read no messages because it did not match this contact.</p>
                  <button onClick={confirmObservedLinkedInIdentity}>Confirm {extensionIdentityCandidate.name} is this contact</button>
                </div>}
                {captureMethod !== "detecting" && <button className="capture-options-toggle" aria-expanded={showImportAlternatives} onClick={() => setShowImportAlternatives((current) => !current)}>{showImportAlternatives ? "Hide other import options" : "Show other import options"}</button>}
                {showImportAlternatives && captureMethod !== "detecting" && <div className="capture-alternatives">
                  {captureEnvironment.supportsScreenCapture && captureMethod !== "screen" && <button onClick={() => void captureConversation()}>Capture conversation screen</button>}
                  {captureEnvironment.supportsScreenCapture && <button onClick={() => void captureContext()}>Capture {contact.name}&apos;s profile screen</button>}
                  <button onClick={() => documentRef.current?.click()}>Import profile/context file</button>
                  {captureMethod !== "manual" && <button onClick={() => chatPasteRef.current?.focus()}>Paste messages manually</button>}
                </div>}
              </div>
              {contact.documents.filter(isConversationCapture).map((document) => {
                const noisy = isLikelyFullLinkedInPageCapture(document);
                return <article className="captured-context" key={document.id}>
                <div className="document-row"><div><strong>{document.name}</strong><small>{noisy ? "Not used by AI — full LinkedIn page detected" : "Exact locally extracted text used as conversation history"}</small></div><button aria-label={"Delete " + document.name} onClick={() => updateContact((current) => ({ ...current, documents: current.documents.filter((item) => item.id !== document.id) }))}>Remove</button></div>
                {noisy && <p className="capture-warning" role="note">This capture contains LinkedIn navigation, another conversation list, or job suggestions. Remove it and capture again, selecting only {contact.name}&apos;s central message column.</p>}
                <pre aria-label={`Captured conversation text for ${contact.name}`}>{document.text}</pre>
              </article>;})}
              <textarea ref={chatPasteRef} aria-label="Paste conversation messages" value={chatPaste} onChange={(event) => setChatPaste(event.target.value)} placeholder={"Paste selected lines only, for example:\nMe: Great to reconnect\nAlex: Likewise—how is the new role?"} />
              <button onClick={importChat}>Import manually pasted chat lines</button>
              <div className="inline-form"><select aria-label="Message sender" value={messageRole} onChange={(event) => setMessageRole(event.target.value as MessageRole)}><option value="them">{contact.name}</option><option value="me">You</option></select><input value={messageBody} onChange={(event) => setMessageBody(event.target.value)} placeholder={`Add one message from ${messageRole === "me" ? "you" : contact.name}`} /><button onClick={addMessage}>Add</button></div>
              <div className="chat-list">{contact.chat.slice(-30).map((message) => <div className={message.role === "me" ? "bubble mine" : "bubble"} key={message.id}><span className="message-meta"><small>{message.role === "me" ? "You" : message.speaker || contact.name}</small><time dateTime={message.createdAt}>{formatRelativeTime(message.createdAt, now)}</time></span>{message.body && <p>{message.body}</p>}{Boolean(message.attachments?.length) && <span className="attachment-row">{message.attachments?.map((attachment) => <small className="attachment-chip" key={attachment.id}>{attachment.kind === "image" ? "Image" : attachment.kind === "file" ? "File" : "Attachment"}: {attachment.label}</small>)}</span>}</div>)}</div>
            </div>
            <div className="panel-card compact">
              <h3>Retention</h3>
              <label>Automatically remove dated context after<select value={contact.retentionDays} onChange={(event) => updateContact((current) => ({ ...current, retentionDays: Number(event.target.value) as Contact["retentionDays"] }))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option><option value={0}>Keep until I delete it</option></select></label>
            </div>
          </> : <div className="empty-state"><div className="brand-mark">1</div><h2>Add a person to begin</h2><p>Only context you deliberately paste, import, or capture will be used.</p><button className="primary" onClick={() => setWizardOpen(true)}>Start guided LinkedIn test</button></div>}
        </section>

        <section className="draft-panel">
          <div className="panel-card guidance-card"><p className="eyebrow">ABOUT YOU · THE CHATHELP USER</p><h2>Your messaging playbook</h2>
            <p className="section-explainer">These instructions describe you and how you want to communicate. They do not describe {contact?.name || "the selected contact"}.</p>
            <label>Your role or team<input value={workspace.guidance.role} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, role: event.target.value } }))} /></label>
            <label>Your relationship goal with {contact?.name || "this contact"}<textarea value={workspace.guidance.objective} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, objective: event.target.value } }))} /></label>
            <label>How your messages should sound<input value={workspace.guidance.voice} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, voice: event.target.value } }))} /></label>
            <label>Rules every reply must follow<textarea value={workspace.guidance.boundaries} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, boundaries: event.target.value } }))} /></label>
          </div>
          <div className="panel-card compose-card">
            <p className="eyebrow">CLOUDFLARE PRIVATE AI</p><h2>Your next reply to {contact?.name || "the selected contact"}</h2>
            <label>What should your next message accomplish?<textarea ref={agendaRef} value={agenda} onChange={(event) => setAgenda(event.target.value)} placeholder={contact ? `Example: Answer ${contact.name}'s latest question naturally and ask one relevant follow-up.` : "Example: Answer their latest question naturally and ask one relevant follow-up."} /></label>
            <div className="provider-summary" role="status"><span>Runs in the cloud</span><strong>{CLOUDFLARE_MODEL_NAME}</strong><small>No LLM model is downloaded or run on this device.</small></div>
            <label>Cloud access code · session-only by default<input type="password" autoComplete="off" value={cloudAccessCode} onChange={(event) => {
              const nextCode = event.target.value.slice(0, 200);
              setCloudAccessCode(nextCode);
              if (workspace.cloudInference.rememberAccessToken) updateWorkspace((current) => ({ ...current, cloudInference: { ...current.cloudInference, accessToken: nextCode } }));
            }} placeholder="Enter the code yourself; it is not saved unless you grant permission below" /></label>
            <label className="consent-check"><input type="checkbox" checked={workspace.cloudInference.rememberAccessToken} onChange={(event) => {
              const rememberAccessToken = event.target.checked;
              updateWorkspace((current) => ({ ...current, cloudInference: { ...current.cloudInference, rememberAccessToken, accessToken: rememberAccessToken ? cloudAccessCode : "" } }));
            }} /><span>Remember this access code in this browser&apos;s encrypted vault. Leave unchecked to forget it when the workspace is locked or closed.</span></label>
            <label className="consent-check"><input type="checkbox" checked={Boolean(workspace.cloudInference.consentedAt)} onChange={(event) => updateWorkspace((current) => ({ ...current, cloudInference: { ...current.cloudInference, consentedAt: event.target.checked ? new Date().toISOString() : "" } }))} /><span>I understand that ChatHelp will send the relevant recent chat, selected context, my guidance, and agenda as text to Cloudflare Workers AI. Screenshots, the full vault, and the access code are not included in the AI prompt.</span></label>
            {!conversationReady && contact && <p className="missing-context" role="note">Before generating, capture only the message area for your LinkedIn conversation with {contact.name}, or add at least one chat message. Full-page captures containing navigation, other chats, or job suggestions are not used.</p>}
            <button className="primary" disabled={!contact || !conversationReady || !agenda.trim() || !cloudReady || Boolean(aiStatus && !aiStatus.includes("Generated") && !aiStatus.includes("processed locally"))} onClick={() => void generate()}>Generate 3 cloud drafts for {contact?.name || "selected contact"}</button>
            {aiStatus && <p className="status" aria-live="polite">{aiStatus}</p>}
            <p className="fine-print">Cloud mode avoids downloading or running an LLM on this device. The Worker uses no app storage or AI Gateway. Review every draft before sending.</p>
          </div>
          <div className="draft-stack">{drafts.map((draft, index) => <article className="draft-card" key={`${contact?.id || "draft"}-${index}`}><div><span>EDITABLE DRAFT {index + 1}</span><div><button onClick={() => {
            void navigator.clipboard.writeText(draft).then(() => setExtensionStatus("Draft copied. Review it in LinkedIn and send it yourself."), () => setAppError("Clipboard access was blocked. Select the draft text and copy it manually."));
          }}>Copy</button><button onClick={() => markDraftManuallySent(draft)}>Mark manually sent</button><button aria-label={`Dismiss draft ${index + 1}`} onClick={() => {
            const nextDrafts = drafts.filter((_item, draftIndex) => draftIndex !== index);
            setDrafts(nextDrafts);
            persistDrafts(nextDrafts);
          }}>Dismiss</button><button title="Useful" aria-label={`Rate draft ${index + 1} useful`} onClick={() => rateDraft(draft, "useful")}>👍</button><button title="Not useful" aria-label={`Rate draft ${index + 1} not useful`} onClick={() => rateDraft(draft, "not-useful")}>👎</button></div></div><textarea aria-label={`Edit draft ${index + 1}`} value={draft} onChange={(event) => setDrafts((current) => current.map((item, draftIndex) => draftIndex === index ? event.target.value.slice(0, 5_000) : item))} onBlur={() => persistDrafts()} /></article>)}</div>
          {Boolean(contact?.draftHistory?.length) && <p className="fine-print">The latest editable set is restored when you return to this contact. Up to 20 draft sets and local usage metadata are retained in the encrypted vault.</p>}
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
          setActiveContactId(contactId);
          setAgenda(nextAgenda);
          await generate(nextAgenda, contactId);
        }}
      />}
      {cropRequest && <ScreenRegionSelector image={cropRequest.image} contactName={cropRequest.contactName} purpose={cropRequest.purpose} onCancel={() => {
        const request = cropRequest;
        setCropRequest(null);
        request.resolve(null);
      }} onConfirm={(region) => {
        const request = cropRequest;
        setCropRequest(null);
        request.resolve(region);
      }} />}
      <dialog ref={shortcutDialogRef} className="privacy-dialog shortcut-dialog"><form method="dialog"><button className="dialog-close" aria-label="Close">×</button><p className="eyebrow">KEYBOARD-FIRST INBOX</p><h2>Shortcuts</h2><dl><div><dt>J / K</dt><dd>Next / previous conversation</dd></div><div><dt>E</dt><dd>Archive or restore selected conversation</dd></div><div><dt>R</dt><dd>Focus reply agenda</dd></div><div><dt>S</dt><dd>Focus snooze time</dd></div><div><dt>L</dt><dd>Focus labels</dd></div><div><dt>Ctrl/⌘ + J</dt><dd>Focus AI draft composer</dd></div><div><dt>G then I</dt><dd>Go to inbox</dd></div><div><dt>?</dt><dd>Show this help</dd></div></dl><p className="fine-print">Shortcuts are disabled while you are typing in a field.</p><button className="primary">Done</button></form></dialog>
      <dialog id="privacy-details" className="privacy-dialog"><form method="dialog"><button className="dialog-close" aria-label="Close">×</button><p className="eyebrow">PRIVACY BOUNDARY</p><h2>What leaves this device?</h2><ul><li><strong>Extension capture:</strong> the Manifest V3 extension receives temporary access only after you click it on a LinkedIn Messaging tab. It reads the open visible conversation and hands the snapshot to this authenticated app through a local extension bridge. It makes no network request, performs no background inbox scan, and cannot send a message.</li><li><strong>No browser LLM:</strong> ChatHelp does not download or run language-model weights on this device.</li><li><strong>Cloud AI (opt-in):</strong> only the relevant recent chat, selected text context, guidance, and agenda are sent to ChatHelp&apos;s authenticated Cloudflare Worker. The Worker has no database, object storage, AI Gateway, or application logging configured.</li><li><strong>Never uploaded:</strong> screen images, the encrypted vault, its device key, and the cloud access code are not included in the AI prompt.</li><li><strong>Device encryption:</strong> this browser stores a non-exportable AES-256 key and uses it to open the local vault automatically after Cloudflare Access authentication. Clearing site data permanently removes this local workspace.</li><li><strong>Access-code storage:</strong> the code is session-only unless you explicitly allow ChatHelp to remember it in the encrypted vault.</li><li><strong>OCR fallback:</strong> if the extension cannot be used, the browser asks you to choose a visible screen and ChatHelp asks you to select only the relevant area. Cropping and OCR run locally.</li><li><strong>Sending:</strong> ChatHelp never sends a LinkedIn message or email. Copying a draft and marking it manually sent are separate human actions.</li><li><strong>Limits:</strong> Cloudflare processes cloud prompts to provide Workers AI. Browser malware, a compromised origin, or someone who controls this browser profile can still expose unlocked data. No software can promise absolute security.</li></ul><button className="primary">Understood</button></form></dialog>
    </main>
  );
}
