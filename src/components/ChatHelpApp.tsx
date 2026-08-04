"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyRetention } from "@/lib/retention";
import { buildOutcomeSummary, containsLinkedInPageNoise, isConversationCapture, isLikelyFullLinkedInPageCapture, selectRelevantContext, validateContextFile } from "@/lib/retrieval";
import { captureVisibleScreen, cropImageToRegion, extractTextFromImage, type NormalizedCropRegion } from "@/lib/localOcr";
import { CLOUDFLARE_MODEL_NAME, generatePrivateDrafts } from "@/lib/privateAi";
import { PLAYBOOK_BACKUP_MAX_BYTES, parsePlaybookBackup, serializePlaybookBackup } from "@/lib/playbookTransfer";
import { PLATFORM_OPTIONS, safePlatformUrl } from "@/lib/platforms";
import {
  LINKEDIN_EXTENSION_SOURCE,
  LINKEDIN_EXTENSION_STATUS_ACK_EVENT,
  LINKEDIN_EXTENSION_STATUS_EVENT,
  LINKEDIN_SNAPSHOT_ACK_EVENT,
  LINKEDIN_SNAPSHOT_EVENT,
  LINKEDIN_SNAPSHOT_REQUEST_EVENT,
  LINKEDIN_SYNC_COMMAND_EVENT,
  LINKEDIN_SYNC_STATE_EVENT,
  PIPELINE_STAGES,
  contactStage,
  isActivelySnoozed,
  isCurrentLinkedInExtensionVersion,
  isLikelyMobileDevice,
  isReminderDue,
  parseLinkedInExtensionStatus,
  parseLinkedInExtensionSnapshot,
  parseLinkedInSyncState,
  recommendLinkedInCaptureMethod,
  upsertLinkedInSnapshot,
  type LinkedInSyncCommand,
  type LinkedInSyncState,
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
  MESSAGING_ROLES,
  PLAYBOOK_GOAL_MAX_CHARS,
  PLAYBOOK_RULES_MAX_CHARS,
  PLAYBOOK_VOICE_MAX_CHARS,
  createEmptyWorkspace,
  newId,
  resolveRoleGuidance,
  type Contact,
  type ConversationPlatform,
  type MessagingRole,
  type MessageRole,
  type PipelineStage,
  type WorkspaceData,
} from "@/lib/workspaceTypes";

const LEGACY_KEY = "chathelp-private-v2";
const STORAGE_CHECK_TIMEOUT_MS = 8_000;
type InboxView = "inbox" | "contacts" | "pipeline" | "reminders" | "labels" | "archived" | "settings";
type InboxFilter = "main" | "to-respond" | "awaiting-reply" | "follow-up-due" | "snoozed" | "new-contacts" | "archived";
const NAV_ITEMS: ReadonlyArray<{ value: InboxView; label: string; glyph: string }> = [
  { value: "inbox", label: "Inbox", glyph: "I" },
  { value: "contacts", label: "Contacts", glyph: "C" },
  { value: "pipeline", label: "Pipeline", glyph: "P" },
  { value: "reminders", label: "Reminders", glyph: "R" },
  { value: "labels", label: "Labels", glyph: "L" },
  { value: "archived", label: "Archived", glyph: "A" },
  { value: "settings", label: "Settings", glyph: "S" },
];
const INBOX_FILTERS: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: "main", label: "Main inbox" },
  { value: "to-respond", label: "To respond" },
  { value: "awaiting-reply", label: "Awaiting reply" },
  { value: "follow-up-due", label: "Follow-up due" },
  { value: "snoozed", label: "Snoozed" },
  { value: "new-contacts", label: "New contacts" },
  { value: "archived", label: "Archived" },
];

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

function latestDraftsForRole(contact: Contact | null | undefined, role: MessagingRole): string[] {
  const history = contact?.draftHistory ?? [];
  return history.findLast((entry) => entry.role === role)?.drafts
    ?? history.findLast((entry) => !entry.role)?.drafts
    ?? [];
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
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("main");
  const [contactSearch, setContactSearch] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [extensionStatus, setExtensionStatus] = useState("Automatic sync disabled. Connect the Chrome extension to enable it on desktop.");
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [syncState, setSyncState] = useState<LinkedInSyncState | null>(null);
  const [manualCaptureHelp, setManualCaptureHelp] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [contextCollapsed, setContextCollapsed] = useState(false);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [captureEnvironment, setCaptureEnvironment] = useState({ detected: false, isMobile: false, supportsScreenCapture: false });
  const [now, setNow] = useState(() => Date.now());
  const [saveStatus, setSaveStatus] = useState("Encrypted");
  const [newContactName, setNewContactName] = useState("");
  const [newPlatform, setNewPlatform] = useState<ConversationPlatform>("linkedin");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [agenda, setAgenda] = useState("");
  const [drafts, setDrafts] = useState<string[]>(() => latestDraftsForRole(initial.contacts[0], initial.inboxRole));
  const [aiStatus, setAiStatus] = useState("");
  const [draftError, setDraftError] = useState("");
  const [appError, setAppError] = useState("");
  const [playbookStatus, setPlaybookStatus] = useState("");
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
  const playbookFileRef = useRef<HTMLInputElement>(null);
  const chatPasteRef = useRef<HTMLTextAreaElement>(null);
  const agendaRef = useRef<HTMLTextAreaElement>(null);
  const snoozeRef = useRef<HTMLInputElement>(null);
  const labelsRef = useRef<HTMLInputElement>(null);
  const shortcutDialogRef = useRef<HTMLDialogElement>(null);
  const workspaceRef = useRef(workspace);
  const extensionConnectedRef = useRef(false);
  const extensionVersionRef = useRef("");
  const shortcutSequenceRef = useRef("");

  const contact = workspace.contacts.find((item) => item.id === selectedId) ?? workspace.contacts[0] ?? null;

  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);

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
        setExtensionStatus(currentVersion
          ? `Chrome extension ${version} connected. Automatic sync is opt-in and currently checking its permission state.`
          : `An older ChatHelp extension${version ? ` (${version})` : ""} is installed. In chrome://extensions, reload the current ChatHelp extension folder, then reload this tab.`);
        return;
      }
      if (data.type === LINKEDIN_SYNC_STATE_EVENT) {
        const state = parseLinkedInSyncState(data.payload);
        if (!state) return;
        extensionConnectedRef.current = true;
        if (isCurrentLinkedInExtensionVersion(extensionVersionRef.current)) setExtensionConnected(true);
        setSyncState(state);
        setExtensionStatus(state.message);
        return;
      }
      if (data.type === LINKEDIN_EXTENSION_STATUS_EVENT) {
        const status = parseLinkedInExtensionStatus(data.payload);
        if (!status) return;
        extensionConnectedRef.current = true;
        if (isCurrentLinkedInExtensionVersion(extensionVersionRef.current)) setExtensionConnected(true);
        setExtensionStatus(status.message);
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
      const preview = upsertLinkedInSnapshot(workspaceRef.current.contacts, snapshot);
      if (preview.action === "ambiguous") {
        setExtensionStatus(`Ambiguous identity for ${snapshot.contact.name}. ChatHelp did not merge or create a duplicate. Add a profile or conversation URL to disambiguate this local contact.`);
        window.postMessage({ source: "chathelp-app", type: LINKEDIN_SNAPSHOT_ACK_EVENT, captureId: snapshot.captureId }, targetOrigin);
        return;
      }
      setWorkspace((current) => {
        const merged = upsertLinkedInSnapshot(current.contacts, snapshot);
        return merged.action === "ambiguous" ? current : { ...current, contacts: merged.contacts };
      });
      const syncedContact = preview.contacts.find((item) => item.id === preview.contactId);
      setSelectedId(preview.contactId);
      setMobileConversationOpen(true);
      setDrafts(latestDraftsForRole(syncedContact, workspaceRef.current.inboxRole));
      setInboxView("inbox");
      setInboxFilter("main");
      setExtensionStatus(preview.action === "created"
        ? `Contact automatically added: ${snapshot.contact.name}. Synchronized ${preview.importedMessages} visible message${preview.importedMessages === 1 ? "" : "s"}.`
        : preview.importedMessages
          ? `Existing contact updated: ${snapshot.contact.name}. Added ${preview.importedMessages} new visible message${preview.importedMessages === 1 ? "" : "s"}.`
          : `No new messages for ${snapshot.contact.name}. The existing local conversation is already current.`);
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
    setWorkspace((current) => {
      const next = updater(current);
      workspaceRef.current = next;
      return next;
    });
  }

  function setActiveContactId(contactId: string) {
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

  function controlAutomaticSync(command: LinkedInSyncCommand) {
    if (captureEnvironment.isMobile) {
      setExtensionStatus("Automatic LinkedIn sync is desktop-only. Use manual paste or import on mobile.");
      return;
    }
    if (!extensionConnected) {
      setExtensionStatus("The current ChatHelp Chrome extension is not connected. Reload version 0.4.2 in chrome://extensions, then reload this tab.");
      return;
    }
    if (command === "enable") setExtensionStatus("Waiting for Chrome's LinkedIn permission decision…");
    if (command === "pause") setExtensionStatus("Pausing automatic sync…");
    if (command === "resume") setExtensionStatus("Resuming automatic sync…");
    if (command === "disable") setExtensionStatus("Disabling automatic sync and revoking LinkedIn permission…");
    const targetOrigin = window.location.origin === "null" ? "*" : window.location.origin;
    window.postMessage({ source: "chathelp-app", type: LINKEDIN_SYNC_COMMAND_EVENT, command }, targetOrigin);
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
    const activeRole = workspace.inboxRole;
    updateContact((current) => {
      const history = current.draftHistory ?? [];
      let targetIndex = -1;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].role === activeRole || (!history[index].role && targetIndex < 0)) {
          targetIndex = index;
          if (history[index].role === activeRole) break;
        }
      }
      return targetIndex < 0 ? current : { ...current, draftHistory: history.map((entry, index) => index === targetIndex ? { ...entry, drafts: nextDrafts } : entry) };
    });
  }

  function changeInboxRole(role: MessagingRole) {
    if (role === workspace.inboxRole) return;
    updateWorkspace((current) => ({ ...current, inboxRole: role }));
    setDrafts([]);
    setDraftError("");
    setAiStatus("");
  }

  function updateRolePlaybook(role: MessagingRole, field: "objective" | "boundaries", value: string) {
    const maxCharacters = field === "boundaries" ? PLAYBOOK_RULES_MAX_CHARS : PLAYBOOK_GOAL_MAX_CHARS;
    updateWorkspace((current) => {
      return {
        ...current,
        guidance: {
          ...current.guidance,
          playbooks: {
            ...current.guidance.playbooks,
            [role]: { ...current.guidance.playbooks[role], [field]: value.slice(0, maxCharacters) },
          },
        },
      };
    });
  }

  function updateSelectedPlaybook(field: "objective" | "boundaries", value: string) {
    updateRolePlaybook(workspace.guidance.selectedRole, field, value);
  }

  async function persistWorkspaceNow(nextWorkspace = workspaceRef.current) {
    setSaveStatus("Encrypting…");
    try {
      await saveVault(applyRetention(nextWorkspace), session);
      setSaveStatus("Encrypted");
      return true;
    } catch (error) {
      setSaveStatus("Save failed");
      setAppError(formatError(error));
      return false;
    }
  }

  async function saveMessagingPlaybooks() {
    setPlaybookStatus("");
    if (await persistWorkspaceNow()) setPlaybookStatus("All four messaging playbooks were saved in the encrypted local vault.");
  }

  function downloadMessagingPlaybooks() {
    const json = serializePlaybookBackup(workspace.guidance, workspace.inboxRole);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `chathelp-messaging-playbooks-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setPlaybookStatus("Downloaded playbook settings only. Contacts, conversations, credentials, and the vault were excluded.");
  }

  async function uploadMessagingPlaybooks(file: File) {
    setPlaybookStatus("");
    try {
      if (file.size > PLAYBOOK_BACKUP_MAX_BYTES) throw new Error("Playbook settings files must be 512 KB or smaller.");
      const imported = parsePlaybookBackup(await file.text());
      const nextWorkspace = { ...workspaceRef.current, guidance: imported.guidance, inboxRole: imported.inboxRole };
      workspaceRef.current = nextWorkspace;
      setWorkspace(nextWorkspace);
      setDrafts([]);
      setDraftError("");
      setAiStatus("");
      if (await persistWorkspaceNow(nextWorkspace)) setPlaybookStatus("Uploaded and encrypted all four messaging playbooks on this device.");
    } catch (error) {
      setAppError(formatError(error));
    } finally {
      if (playbookFileRef.current) playbookFileRef.current.value = "";
    }
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
    const draftingRole = workspace.inboxRole;
    const requestAgenda = (agendaOverride ?? agenda).trim();
    if (!activeContact) return;
    if (!hasConversationContext(activeContact)) {
      const rejectedFullPage = activeContact.documents.some((document) => isConversationCapture(document) && isLikelyFullLinkedInPageCapture(document));
      setAppError(rejectedFullPage
        ? `The saved capture for ${activeContact.name} contains LinkedIn navigation, other chats, or job suggestions, so ChatHelp will not send it to AI. Remove it and capture only the central message column.`
        : `Add recent chat history with ${activeContact.name} before generating. Capture only the LinkedIn message area or add at least one message.`);
      return;
    }
    setAppError("");
    setDraftError("");
    setDrafts([]);
    try {
      const query = [requestAgenda, activeContact.profileNotes, activeContact.chat.slice(-8).map((item) => item.body).join(" ")].join(" ");
      const relevant = selectRelevantContext(activeContact.documents.filter((document) => !isConversationCapture(document) && !isLikelyFullLinkedInPageCapture(document)), query);
      const feedbackSummary = workspace.feedback.filter((item) => item.contactId === activeContact.id).slice(-20).map((item) => item.rating + ": " + item.note).join("\n");
      const nextDrafts = await generatePrivateDrafts(CLOUDFLARE_MODEL_ID, {
        contact: activeContact,
        guidance: resolveRoleGuidance(workspace.guidance, draftingRole),
        latestQuestion: requestAgenda,
        retrievedContext: relevant,
        feedbackSummary,
        outcomeSummary: buildOutcomeSummary(activeContact),
      }, setAiStatus, { ...workspace.cloudInference, accessToken: cloudAccessCode });
      if (workspaceRef.current.inboxRole !== draftingRole) {
        setAiStatus("");
        return;
      }
      setDrafts(nextDrafts);
      const generatedAt = new Date().toISOString();
      updateWorkspace((current) => ({
        ...current,
        contacts: current.contacts.map((item) => item.id === activeContact.id ? {
          ...item,
          draftHistory: [...(item.draftHistory ?? []), { id: newId("draft-set"), agenda: requestAgenda.slice(0, 5_000), drafts: nextDrafts, createdAt: generatedAt, role: draftingRole }].slice(-20),
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
      setDraftError(formatError(error));
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
      const archivedView = inboxView === "archived" || inboxFilter === "archived";
      if (archivedView ? !item.archivedAt : Boolean(item.archivedAt)) return false;
      if (inboxFilter === "main" && inboxView === "inbox" && isActivelySnoozed(item, now)) return false;
      if (inboxFilter === "to-respond" && item.chat.at(-1)?.role !== "them") return false;
      if (inboxFilter === "awaiting-reply" && item.chat.at(-1)?.role !== "me") return false;
      if (inboxFilter === "follow-up-due" && !isReminderDue(item, now)) return false;
      if (inboxFilter === "snoozed" && !isActivelySnoozed(item, now)) return false;
      if (inboxFilter === "new-contacts" && item.source !== "linkedin-extension") return false;
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
  }, [contactSearch, inboxFilter, inboxView, labelFilter, now, workspace.contacts]);
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
        setDrafts(latestDraftsForRole(nextContact, workspace.inboxRole));
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
  }, [contact, visibleContacts, workspace.inboxRole]);

  const storageSummary = useMemo(() => contact ? contact.chat.length + " messages · " + contact.documents.length + " context files · " + contact.outcomes.length + " outcomes · " + (contact.draftHistory?.length ?? 0) + " draft sets" : "No contact selected", [contact]);
  const latestMeaningfulIncomingId = useMemo(() => contact?.chat.findLast((message) => message.role === "them" && (message.body.trim() || message.attachments?.length))?.id ?? "", [contact]);
  const selectedSettingsPlaybook = workspace.guidance.playbooks[workspace.guidance.selectedRole];
  const handoffUrl = contact ? safePlatformUrl(contact) : null;
  const cloudReady = Boolean(workspace.cloudInference.consentedAt && cloudAccessCode.trim().length >= 20);
  const conversationReady = Boolean(contact && hasConversationContext(contact));
  const captureMethod = recommendLinkedInCaptureMethod({
    detected: captureEnvironment.detected,
    extensionConnected,
    isMobile: captureEnvironment.isMobile,
    supportsScreenCapture: captureEnvironment.supportsScreenCapture,
  });
  const automaticSyncLabel = !extensionConnected
    ? "Extension not connected"
    : syncState?.enabled
      ? syncState.paused ? "Sync paused" : "Automatic sync enabled"
      : syncState?.code === "permission_removed" ? "Permission removed" : "Automatic sync disabled";

  function renderWorkspace() {
    const renderAvatar = (item: Contact, className = "") => item.avatarUrl
      ? <img className={className} src={item.avatarUrl} alt="" referrerPolicy="no-referrer" />
      : <span className={className + " contact-avatar"} aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span>;

    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="topbar-brand"><div className="brand-mark" aria-hidden="true">CH</div><div><p className="eyebrow">CHATHELP</p><h1>Private conversation studio</h1></div></div>
          <div className="top-actions">
            {dueReminderCount > 0 && <button className="reminder-badge" onClick={() => { setInboxView("reminders"); setInboxFilter("follow-up-due"); }}>{dueReminderCount} due</button>}
            <button onClick={() => shortcutDialogRef.current?.showModal()} aria-label="Show keyboard shortcuts">Shortcuts</button>
            <button className="wizard-launch" data-testid="open-linkedin-test-wizard" onClick={() => setWizardOpen(true)}>Guided import</button>
            <PwaInstall />
            <span className="save-state">● {saveStatus}</span>
          </div>
        </header>
        <div className="privacy-strip">
          <strong>Local-first workspace.</strong> ChatHelp reads only the visible LinkedIn conversation you manually open after you opt in. It never accesses cookies, scans the inbox, opens chats, clicks, types, scrolls, or sends. <button onClick={() => (document.getElementById("privacy-details") as HTMLDialogElement | null)?.showModal()}>Privacy details</button>
        </div>
        {appError && <div className="notice error" role="alert">{appError}<button aria-label="Dismiss" onClick={() => setAppError("")}>×</button></div>}

        <div className={"workspace-frame" + (navCollapsed ? " nav-is-collapsed" : "") + (contextCollapsed ? " context-is-collapsed" : "")}>
          <aside className="workspace-nav" aria-label="Workspace navigation">
            <div className="nav-brand"><div className="brand-mark" aria-hidden="true">CH</div><strong>ChatHelp</strong><button aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setNavCollapsed((current) => !current)}>{navCollapsed ? "›" : "‹"}</button></div>
            <nav>
              {NAV_ITEMS.map((item) => <button key={item.value} className={inboxView === item.value ? "active" : ""} aria-current={inboxView === item.value ? "page" : undefined} onClick={() => {
                setInboxView(item.value);
                if (item.value === "archived") setInboxFilter("archived");
                else if (item.value === "reminders") setInboxFilter("follow-up-due");
                else if (item.value === "inbox") setInboxFilter("main");
              }}><span aria-hidden="true">{item.glyph}</span><b>{item.label}</b>{item.value === "reminders" && dueReminderCount > 0 && <small>{dueReminderCount}</small>}</button>)}
            </nav>
            <div className="nav-privacy"><span className={"sync-dot " + (syncState?.enabled && !syncState.paused ? "on" : "")} /><b>{automaticSyncLabel}</b><small>Encrypted on this device</small></div>
          </aside>

          <section className={"inbox-column" + (mobileConversationOpen ? " mobile-list-hidden" : "")} aria-label="Conversation inbox">
            <header className="inbox-header">
              <div><p className="eyebrow">CONVERSATIONS</p><h2>{inboxView === "archived" ? "Archived" : inboxView === "reminders" ? "Reminders" : inboxView === "contacts" ? "Contacts" : inboxView === "labels" ? "Labels" : "Inbox"}</h2></div>
              <span>{visibleContacts.length}</span>
            </header>
            <label className="search-field"><span className="sr-only">Search conversations</span><input aria-label="Search conversations" value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Search conversations" /></label>
            {inboxView === "inbox" && <label className="inbox-role-select"><span>Your role or team</span><select aria-label="Your role or team" value={workspace.inboxRole} onChange={(event) => changeInboxRole(event.target.value as MessagingRole)}>{MESSAGING_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>}

            <section className={"sync-card sync-" + (syncState?.enabled ? syncState.paused ? "paused" : "on" : "off")} aria-labelledby="sync-card-title">
              <div className="sync-card-heading"><span className="sync-dot" /><div><strong id="sync-card-title">{automaticSyncLabel}</strong><small role="status" aria-live="polite">{extensionStatus}</small></div></div>
              {captureEnvironment.isMobile ? <p>Automatic LinkedIn sync is desktop-only. Manual paste and import remain available.</p> : <>
                {!syncState?.enabled && <button className="primary" disabled={!extensionConnected} onClick={() => controlAutomaticSync("enable")}>Enable automatic LinkedIn conversation sync</button>}
                {syncState?.enabled && !syncState.paused && <div className="sync-actions"><button onClick={() => controlAutomaticSync("pause")}>Pause automatic sync</button><button className="danger-link" onClick={() => controlAutomaticSync("disable")}>Disable and revoke LinkedIn permission</button></div>}
                {syncState?.enabled && syncState.paused && <div className="sync-actions"><button className="primary" onClick={() => controlAutomaticSync("resume")}>Resume automatic sync</button><button className="danger-link" onClick={() => controlAutomaticSync("disable")}>Disable and revoke LinkedIn permission</button></div>}
                <button className="text-button" onClick={() => setManualCaptureHelp((current) => !current)}>One-time manual capture</button>
                {manualCaptureHelp && <p className="manual-capture-help">Open the conversation in LinkedIn and click the ChatHelp extension icon once. This fallback works without enabling automatic sync and never sends a message.</p>}
              </>}
              <p className="sync-disclosure">When automatic sync is enabled, ChatHelp reads the visible LinkedIn conversation you manually open. It does not scan the inbox, access LinkedIn cookies, open conversations, or send messages.</p>
            </section>

            <div className="inbox-filter-row">
              <select aria-label="Inbox filter" value={inboxFilter} onChange={(event) => setInboxFilter(event.target.value as InboxFilter)}>{INBOX_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select>
              <select aria-label="Filter by label" value={labelFilter} onChange={(event) => setLabelFilter(event.target.value)}><option value="">All labels</option>{allLabels.map((label) => <option key={label} value={label}>{label}</option>)}</select>
            </div>

            <nav className="conversation-list" aria-label="Conversations">
              {visibleContacts.map((item) => {
                const latest = item.chat.at(-1);
                const reminderAt = item.followUpAt || item.snoozedUntil;
                return <button className={item.id === contact?.id ? "conversation-row active" : "conversation-row"} key={item.id} onClick={() => {
                  setSelectedId(item.id);
                  setDrafts(latestDraftsForRole(item, workspace.inboxRole));
                  setDraftError("");
                  setMobileConversationOpen(true);
                }}>
                  {renderAvatar(item)}
                  <span className="conversation-row-body">
                    <span className="conversation-row-title"><strong>{item.name}</strong><time dateTime={latest?.createdAt || item.lastSyncedAt}>{formatRelativeTime(latest?.createdAt || item.lastSyncedAt, now)}</time></span>
                    <span className="conversation-preview">{latest?.body || item.headline || "No conversation imported yet"}</span>
                    <span className="conversation-row-meta"><small className={"stage-pill stage-" + contactStage(item)}>{PIPELINE_STAGES.find((stage) => stage.value === contactStage(item))?.label}</small>{item.source === "linkedin-extension" && <small className="new-chip">Synced</small>}{reminderAt && <small className={isReminderDue(item, now) ? "reminder-due" : ""}>Follow-up {formatRelativeTime(reminderAt, now)}</small>}{isActivelySnoozed(item, now) && <small>Snoozed</small>}</span>
                    {Boolean(item.labels?.length) && <span className="label-row">{item.labels?.slice(0, 3).map((label) => <small key={label} className="label-chip">{label}</small>)}</span>}
                  </span>
                  {item.lastSyncedAt && <span className="updated-dot" title="Synchronized conversation" aria-label="Synchronized conversation" />}
                </button>;
              })}
            </nav>
            {!visibleContacts.length && <div className="inbox-empty"><strong>No conversations here yet</strong><p>Open a LinkedIn conversation after enabling sync, or add one manually in Settings.</p></div>}
          </section>

          {inboxView === "pipeline" ? <section className="conversation-column pipeline-view-column">
            <header className="conversation-header"><div><p className="eyebrow">LOCAL WORKFLOW</p><h2>Conversation pipeline</h2><p>Drag contacts between stages. This changes only the encrypted local workspace.</p></div></header>
            <div className="pipeline-board">{PIPELINE_STAGES.map((stage) => <section className="pipeline-column" key={stage.value} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/contact-id"); if (id) moveContactToStage(id, stage.value); }}>
              <header><strong>{stage.label}</strong><span>{stageCounts[stage.value]}</span></header>
              <div>{workspace.contacts.filter((item) => !item.archivedAt && contactStage(item) === stage.value).map((item) => <article className={item.id === contact?.id ? "pipeline-card selected" : "pipeline-card"} draggable key={item.id} onDragStart={(event) => event.dataTransfer.setData("text/contact-id", item.id)} onClick={() => {
                setSelectedId(item.id);
                setDrafts(latestDraftsForRole(item, workspace.inboxRole));
                setDraftError("");
                setMobileConversationOpen(true);
              }}><div><strong>{item.name}</strong><small>{formatRelativeTime(item.chat.at(-1)?.createdAt || item.lastSyncedAt, now)}</small></div><p>{item.chat.at(-1)?.body || item.headline || "No message preview"}</p><select aria-label={"Move " + item.name + " to pipeline stage"} value={contactStage(item)} onClick={(event) => event.stopPropagation()} onChange={(event) => moveContactToStage(item.id, event.target.value as PipelineStage)}>{PIPELINE_STAGES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></article>)}</div>
            </section>)}</div>
          </section> : inboxView === "settings" ? <section className="conversation-column settings-column">
            <header className="conversation-header"><div><p className="eyebrow">SETTINGS</p><h2>Workspace and drafting</h2><p>Preferences and guidance stay in this encrypted browser vault.</p></div></header>
            <div className="settings-scroll">
              <section className="panel-card"><h3>Add a contact manually</h3><p className="section-explainer">Automatic sync creates new LinkedIn contacts for you. Manual creation remains available for other services and fallback imports.</p><label>Conversation platform<select aria-label="Conversation platform" value={newPlatform} onChange={(event) => setNewPlatform(event.target.value as ConversationPlatform)}>{PLATFORM_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><div className="inline-form"><input aria-label="New contact name" value={newContactName} onChange={(event) => setNewContactName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && addContact()} placeholder="New contact name" /><button onClick={addContact}>Add</button></div></section>
              <section className="panel-card guidance-card">
                <p className="eyebrow">ABOUT YOU</p>
                <h3>Your messaging playbook</h3>
                <label>Your role or team<select value={workspace.guidance.selectedRole} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, selectedRole: event.target.value as MessagingRole } }))}>{MESSAGING_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
                <label>Your relationship goal<textarea aria-label="Your relationship goal" maxLength={PLAYBOOK_GOAL_MAX_CHARS} value={selectedSettingsPlaybook.objective} onChange={(event) => updateSelectedPlaybook("objective", event.target.value)} /><small>{selectedSettingsPlaybook.objective.length.toLocaleString()} / {PLAYBOOK_GOAL_MAX_CHARS.toLocaleString()} characters</small></label>
                <label>How your messages should sound<input maxLength={PLAYBOOK_VOICE_MAX_CHARS} value={workspace.guidance.voice} onChange={(event) => updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, voice: event.target.value.slice(0, PLAYBOOK_VOICE_MAX_CHARS) } }))} /></label>
                <label>Rules every reply must follow<textarea aria-label="Rules every reply must follow" maxLength={PLAYBOOK_RULES_MAX_CHARS} value={selectedSettingsPlaybook.boundaries} onChange={(event) => updateSelectedPlaybook("boundaries", event.target.value)} /><small>{selectedSettingsPlaybook.boundaries.length.toLocaleString()} / {PLAYBOOK_RULES_MAX_CHARS.toLocaleString()} characters</small></label>
                <input ref={playbookFileRef} hidden type="file" accept=".json,application/json" onChange={(event) => event.target.files?.[0] && void uploadMessagingPlaybooks(event.target.files[0])} />
                <div className="playbook-actions"><button type="button" className="primary" onClick={() => void saveMessagingPlaybooks()}>Save playbook settings</button><button type="button" onClick={() => playbookFileRef.current?.click()}>Upload settings</button><button type="button" onClick={downloadMessagingPlaybooks}>Download settings</button></div>
                <p className="section-explainer">Uploads and downloads contain only these four role playbooks and the shared message voice—never contacts, conversations, credentials, or access codes.</p>
                {playbookStatus && <p className="status" role="status" aria-live="polite">{playbookStatus}</p>}
              </section>
              <section className="panel-card"><p className="eyebrow">CLOUDFLARE PRIVATE AI</p><h3>Draft-generation consent</h3><div className="provider-summary"><span>Same-origin endpoint</span><strong>{CLOUDFLARE_MODEL_NAME}</strong><small>Conversation text is sent only when you click Generate.</small></div><label>Cloud access code · session-only by default<input type="password" autoComplete="off" value={cloudAccessCode} onChange={(event) => { const nextCode = event.target.value.slice(0, 200); setCloudAccessCode(nextCode); if (workspace.cloudInference.rememberAccessToken) updateWorkspace((current) => ({ ...current, cloudInference: { ...current.cloudInference, accessToken: nextCode } })); }} placeholder="Enter the code yourself" /></label><label className="consent-check"><input type="checkbox" checked={workspace.cloudInference.rememberAccessToken} onChange={(event) => { const rememberAccessToken = event.target.checked; updateWorkspace((current) => ({ ...current, cloudInference: { ...current.cloudInference, rememberAccessToken, accessToken: rememberAccessToken ? cloudAccessCode : "" } })); }} /><span>Remember this access code in the encrypted vault.</span></label><label className="consent-check"><input type="checkbox" checked={Boolean(workspace.cloudInference.consentedAt)} onChange={(event) => updateWorkspace((current) => ({ ...current, cloudInference: { ...current.cloudInference, consentedAt: event.target.checked ? new Date().toISOString() : "" } }))} /><span>I understand that relevant visible conversation text, my guidance, and my objective will be sent to ChatHelp&apos;s authenticated Cloudflare Worker only when I request drafts. Screenshots, cookies, the full vault, and access credentials are not included in the AI request.</span></label></section>
            </div>
          </section> : <section className={"conversation-column" + (!mobileConversationOpen ? " mobile-conversation-hidden" : "")}>
            {contact ? <>
              <header className="conversation-header">
                <button className="mobile-back" onClick={() => setMobileConversationOpen(false)}>← Inbox</button>
                {renderAvatar(contact, "conversation-avatar")}
                <div className="conversation-identity"><h2>{contact.name}</h2><p>{[contact.headline, contact.company].filter(Boolean).join(" · ") || "LinkedIn conversation"}</p>{contact.profileUrl && <a href={contact.profileUrl} target="_blank" rel="noreferrer">View LinkedIn profile ↗</a>}</div>
                <div className="conversation-header-actions"><span className={"sync-status-pill " + (syncState?.enabled && !syncState.paused ? "on" : "")}>{contact.lastSyncedAt ? "Synchronized " + formatRelativeTime(contact.lastSyncedAt, now) : automaticSyncLabel}</span><select aria-label={"Pipeline stage for " + contact.name} value={contactStage(contact)} onChange={(event) => moveContactToStage(contact.id, event.target.value as PipelineStage)}>{PIPELINE_STAGES.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select><button onClick={() => setContextCollapsed((current) => !current)}>{contextCollapsed ? "Show contact" : "Hide contact"}</button></div>
              </header>

              <div className="conversation-scroll">
                <div className="message-thread" aria-label={"Conversation with " + contact.name}>
                  {contact.chat.length ? contact.chat.map((message) => <article className={"bubble " + (message.role === "me" ? "mine " : "") + (message.id === latestMeaningfulIncomingId ? "latest-incoming" : "")} key={message.id}><span className="message-meta"><strong>{message.role === "me" ? "You" : message.speaker || contact.name}</strong><time dateTime={message.createdAt}>{formatRelativeTime(message.createdAt, now)}</time></span>{message.body && <p>{message.body}</p>}{Boolean(message.attachments?.length) && <span className="attachment-row">{message.attachments?.map((attachment) => <small className="attachment-chip" key={attachment.id}>{attachment.kind}: {attachment.label}</small>)}</span>}{message.id === latestMeaningfulIncomingId && <small className="latest-marker">Latest meaningful incoming message</small>}</article>) : <div className="thread-empty"><strong>No messages synchronized yet</strong><p>Enable automatic sync, then manually open this conversation on LinkedIn. ChatHelp will never open or scroll it for you.</p></div>}
                </div>

                <details className="import-fallback">
                  <summary>Manual capture and import fallback</summary>
                  <div className={"capture-recommendation capture-" + captureMethod} data-testid="recommended-linkedin-import"><div><strong>{captureEnvironment.isMobile ? "Manual import" : "One-time local fallback"}</strong><p>Use screen-area OCR, paste selected messages, or click the extension once on an open LinkedIn conversation.</p></div><div className="capture-alternatives">{captureEnvironment.supportsScreenCapture && <button onClick={() => void captureConversation()}>Capture conversation screen</button>}<button onClick={() => chatPasteRef.current?.focus()}>Paste messages</button><button onClick={() => documentRef.current?.click()}>Import context file</button></div></div>
                  <input ref={documentRef} hidden type="file" accept=".txt,.md,.json,text/plain,application/json" onChange={(event) => event.target.files?.[0] && void importDocument(event.target.files[0])} />
                  <textarea ref={chatPasteRef} aria-label="Paste conversation messages" value={chatPaste} onChange={(event) => setChatPaste(event.target.value)} placeholder={"Me: Great to reconnect\nAlex: Likewise—how is the new role?"} />
                  <button onClick={importChat}>Import manually pasted chat lines</button>
                  <div className="inline-form"><select aria-label="Message sender" value={messageRole} onChange={(event) => setMessageRole(event.target.value as MessageRole)}><option value="them">{contact.name}</option><option value="me">You</option></select><input value={messageBody} onChange={(event) => setMessageBody(event.target.value)} placeholder="Add one message" /><button onClick={addMessage}>Add</button></div>
                </details>

                <section className="composer-card">
                  <div className="composer-heading"><div><p className="eyebrow">PRIVATE DRAFTING</p><h3>Reply to {contact.name}</h3></div><span>Manual review and send only</span></div>
                  <label>What should your reply accomplish? <span className="field-optional">Optional</span><textarea aria-label="What should your reply accomplish?" ref={agendaRef} maxLength={5_000} value={agenda} onChange={(event) => setAgenda(event.target.value.slice(0, 5_000))} placeholder="Optional—leave blank to reply strictly from the existing chat, latest message, and selected-role rules." /><small>When provided, this objective is applied together with—not instead of—the conversation and playbook rules.</small></label>
                  {!cloudReady && <p className="missing-context">Finish Cloudflare draft consent in Settings before generating.</p>}
                  {!conversationReady && <p className="missing-context">Synchronize or manually import at least one relevant message first.</p>}
                  <div className="generate-row"><button className="primary" disabled={!conversationReady || !cloudReady || Boolean(aiStatus && !aiStatus.includes("Generated") && !aiStatus.includes("processed locally"))} onClick={() => void generate()}>Generate 3 drafts for {contact.name}</button>{aiStatus && <span className="status" aria-live="polite">{aiStatus}</span>}</div>
                  {draftError && <div className="notice error inline-draft-error" role="alert"><span><strong>Drafts were not generated.</strong> {draftError}</span><button aria-label="Dismiss draft generation error" onClick={() => setDraftError("")}>×</button></div>}
                </section>

                <div className="draft-stack">{drafts.map((draft, index) => <article className="draft-card" key={contact.id + "-" + index}><div><span>DRAFT {index + 1}</span><div><button onClick={() => void navigator.clipboard.writeText(draft).then(() => setExtensionStatus("Draft copied. Review and send it yourself."), () => setAppError("Clipboard access was blocked."))}>Copy</button><button onClick={() => markDraftManuallySent(draft)}>Mark manually sent</button><button aria-label={"Dismiss draft " + (index + 1)} onClick={() => { const nextDrafts = drafts.filter((_item, draftIndex) => draftIndex !== index); setDrafts(nextDrafts); persistDrafts(nextDrafts); }}>Dismiss</button><button title="Useful" aria-label={"Rate draft " + (index + 1) + " useful"} onClick={() => rateDraft(draft, "useful")}>Useful</button><button title="Not useful" aria-label={"Rate draft " + (index + 1) + " not useful"} onClick={() => rateDraft(draft, "not-useful")}>Not useful</button></div></div><textarea aria-label={"Edit draft " + (index + 1)} value={draft} onChange={(event) => setDrafts((current) => current.map((item, draftIndex) => draftIndex === index ? event.target.value.slice(0, 5_000) : item))} onBlur={() => persistDrafts()} /></article>)}</div>
                {handoffUrl && <a className="platform-link" href={handoffUrl} target="_blank" rel="noreferrer">Open LinkedIn to review and paste ↗</a>}
              </div>
            </> : <div className="empty-state"><div className="brand-mark">CH</div><h2>Open your first conversation</h2><p>Enable automatic sync, then manually open a LinkedIn conversation. Unknown contacts are added locally without inbox crawling.</p></div>}
          </section>}

          <aside className="contact-context" aria-label="Contact context">
            {contact ? <>
              <header><button aria-label={contextCollapsed ? "Expand contact context" : "Collapse contact context"} onClick={() => setContextCollapsed((current) => !current)}>{contextCollapsed ? "‹" : "×"}</button>{renderAvatar(contact, "context-avatar")}<h2>{contact.name}</h2><p>{contact.headline || "No headline synchronized"}</p><small>{contact.company || "No visible company"}</small>{contact.profileUrl && <a href={contact.profileUrl} target="_blank" rel="noreferrer">Visit LinkedIn profile ↗</a>}</header>
              <div className="contact-context-scroll">
                <section><h3>Workflow</h3><label>Pipeline stage<select value={contactStage(contact)} onChange={(event) => moveContactToStage(contact.id, event.target.value as PipelineStage)}>{PIPELINE_STAGES.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></label><label>Labels<input key={contact.id} ref={labelsRef} defaultValue={(contact.labels || []).join(", ")} onBlur={(event) => updateContact((current) => ({ ...current, labels: parseLabels(event.target.value) }))} placeholder="warm lead, client" /></label><label>Relationship notes<textarea value={contact.notes || ""} onChange={(event) => updateContact((current) => ({ ...current, notes: event.target.value.slice(0, 20_000) }))} /></label><label>Follow-up reminder<input type="datetime-local" value={toDateTimeLocal(contact.followUpAt)} onChange={(event) => updateContact((current) => ({ ...current, followUpAt: fromDateTimeLocal(event.target.value), pipelineStage: event.target.value ? "follow-up" : contactStage(current) }))} /></label><label>Snooze until<input ref={snoozeRef} type="datetime-local" value={toDateTimeLocal(contact.snoozedUntil)} onChange={(event) => updateContact((current) => ({ ...current, snoozedUntil: fromDateTimeLocal(event.target.value), pipelineStage: event.target.value ? "snoozed" : contactStage(current) }))} /></label></section>
                <section><h3>Synchronization</h3><dl><div><dt>Source</dt><dd>{contact.source === "linkedin-extension" ? "Opened LinkedIn conversation" : "Manual"}</dd></div><div><dt>First synchronized</dt><dd>{contact.firstSyncedAt ? new Date(contact.firstSyncedAt).toLocaleString() : "Not yet"}</dd></div><div><dt>Last synchronized</dt><dd>{contact.lastSyncedAt ? new Date(contact.lastSyncedAt).toLocaleString() : "Not yet"}</dd></div><div><dt>Visible messages</dt><dd>{contact.lastSyncMessageCount || contact.chat.length}</dd></div></dl></section>
                <section><h3>Conversation outcome</h3><div className="inline-form"><select aria-label="Conversation outcome" value={outcomeResult} onChange={(event) => setOutcomeResult(event.target.value as typeof outcomeResult)}><option value="positive">Positive</option><option value="neutral">Neutral</option><option value="negative">Negative</option></select><input value={outcomeNote} onChange={(event) => setOutcomeNote(event.target.value)} placeholder="What happened?" /><button onClick={addOutcome}>Save</button></div>{contact.outcomes.at(-1) && <p className="context-summary"><strong>{contact.outcomes.at(-1)?.result}</strong> {contact.outcomes.at(-1)?.note}</p>}</section>
                <section><h3>Local storage and retention</h3><p>{storageSummary}. Stored only in this encrypted local vault.</p><label>Remove dated context after<select value={contact.retentionDays} onChange={(event) => updateContact((current) => ({ ...current, retentionDays: Number(event.target.value) as Contact["retentionDays"] }))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option><option value={0}>Keep until I delete it</option></select></label></section>
                <section><h3>Profile details</h3><label>Name<input value={contact.name} onChange={(event) => updateContact((current) => ({ ...current, name: event.target.value.slice(0, 200) }))} /></label><label>Headline<input value={contact.headline} onChange={(event) => updateContact((current) => ({ ...current, headline: event.target.value.slice(0, 500) }))} /></label><label>Company<input value={contact.company || ""} onChange={(event) => updateContact((current) => ({ ...current, company: event.target.value.slice(0, 500) }))} /></label><label>Relevant profile notes<textarea value={contact.profileNotes} onChange={(event) => updateContact((current) => ({ ...current, profileNotes: event.target.value.slice(0, 20_000) }))} /></label></section>
                <div className="context-actions"><button onClick={() => toggleArchive(contact)}>{contact.archivedAt ? "Restore to inbox" : "Archive"}</button><button className="danger-link" onClick={deleteContact}>Delete local contact</button></div>
              </div>
            </> : <div className="context-empty">Select a conversation to see local contact context.</div>}
          </aside>
        </div>

        <footer><span>ChatHelp never sends platform messages or email automatically.</span><button className="danger-link" onClick={() => void eraseEverything()}>Erase all local data</button></footer>
        {wizardOpen && <LinkedInTestWizard initialContact={contact} guidance={resolveRoleGuidance(workspace.guidance, workspace.inboxRole)} drafts={drafts} aiStatus={draftError ? "Drafts were not generated. " + draftError : aiStatus} onClose={() => setWizardOpen(false)} onSaveProfile={saveWizardProfile} onCapture={captureContextFor} onImportChat={importChatFor} onGuidanceChange={(field, value) => { if (field === "role") changeInboxRole(value as MessagingRole); else if (field === "voice") updateWorkspace((current) => ({ ...current, guidance: { ...current.guidance, voice: value.slice(0, PLAYBOOK_VOICE_MAX_CHARS) } })); else updateRolePlaybook(workspace.inboxRole, field, value); }} onGenerate={async (contactId, nextAgenda) => { setActiveContactId(contactId); setAgenda(nextAgenda); await generate(nextAgenda, contactId); }} />}
        {cropRequest && <ScreenRegionSelector image={cropRequest.image} contactName={cropRequest.contactName} purpose={cropRequest.purpose} onCancel={() => { const request = cropRequest; setCropRequest(null); request.resolve(null); }} onConfirm={(region) => { const request = cropRequest; setCropRequest(null); request.resolve(region); }} />}
        <dialog ref={shortcutDialogRef} className="privacy-dialog shortcut-dialog"><form method="dialog"><button className="dialog-close" aria-label="Close">×</button><p className="eyebrow">KEYBOARD-FIRST INBOX</p><h2>Shortcuts</h2><dl><div><dt>J / K</dt><dd>Next / previous conversation</dd></div><div><dt>E</dt><dd>Archive or restore</dd></div><div><dt>R</dt><dd>Focus reply objective</dd></div><div><dt>S</dt><dd>Focus snooze</dd></div><div><dt>L</dt><dd>Focus labels</dd></div><div><dt>Ctrl/⌘ + J</dt><dd>Focus draft composer</dd></div><div><dt>G then I</dt><dd>Go to inbox</dd></div><div><dt>?</dt><dd>Show help</dd></div></dl><button className="primary">Done</button></form></dialog>
        <dialog id="privacy-details" className="privacy-dialog"><form method="dialog"><button className="dialog-close" aria-label="Close">×</button><p className="eyebrow">PRIVACY BOUNDARY</p><h2>What leaves this device?</h2><ul><li><strong>Automatic sync:</strong> after explicit optional host permission, an isolated content script reads only the visible central LinkedIn conversation you manually open. It never reads cookies, scans the inbox, opens chats, clicks, types, scrolls, or sends.</li><li><strong>Local handoff:</strong> synchronized snapshots pass through the existing extension bridge into this authenticated app and are encrypted in the local vault. Automatic snapshots are not retained in extension storage.</li><li><strong>One-time fallback:</strong> a manual toolbar capture may remain only in extension session storage until this app acknowledges it.</li><li><strong>Cloud AI:</strong> relevant recent conversation text, guidance, and your objective are sent to the authenticated same-origin /api/drafts endpoint only when you click Generate.</li><li><strong>Never uploaded:</strong> screenshots, cookies, session tokens, access credentials, the full vault, navigation, job cards, side panels, and unrelated conversations are excluded.</li><li><strong>Sending:</strong> every draft requires manual review, copy, paste, and sending.</li></ul><button className="primary">Understood</button></form></dialog>
      </main>
    );
  }

  return renderWorkspace();
}
