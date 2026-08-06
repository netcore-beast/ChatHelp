importScripts("extractor.js");

const PRODUCTION_APP_URL = "https://chathelp-private-cloud.project-mission-ai.workers.dev/";
const TESTING_APP_URL = "https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/";
const APP_URLS = [PRODUCTION_APP_URL, TESTING_APP_URL];
const LINKEDIN_ORIGIN = "https://www.linkedin.com/*";
const LINKEDIN_MESSAGING = "https://www.linkedin.com/messaging/*";
const SYNC_SCRIPT_ID = "chathelp-linkedin-auto-sync-v1";
const SYNC_ENABLED_KEY = "linkedinAutoSyncEnabled";
const SYNC_PAUSED_KEY = "linkedinAutoSyncPaused";
const LAST_CONTACT_KEY = "linkedinLastSyncedContact";
const LAST_MESSAGE_COUNT_KEY = "linkedinLastSyncedMessageCount";
const MANUAL_SNAPSHOT_KEY = "pendingManualLinkedInSnapshot";
const MANUAL_STATUS_KEY = "pendingManualLinkedInStatus";
const SNAPSHOT_EVENT = "CHATHELP_LINKEDIN_SNAPSHOT";
const STATUS_EVENT = "CHATHELP_LINKEDIN_EXTENSION_STATUS";
let syncContentScriptRegistration = null;
let syncRestoreOperation = null;
const SYNC_STATE_EVENT = "CHATHELP_LINKEDIN_SYNC_STATE";
const SYNC_STATE_CHANGED = "CHATHELP_LINKEDIN_SYNC_STATE_CHANGED";

function safeLinkedInUrl(value, prefix) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || (parsed.hostname !== "linkedin.com" && parsed.hostname !== "www.linkedin.com") || !parsed.pathname.startsWith(prefix)) return "";
    parsed.hostname = "www.linkedin.com";
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeObservedContact(value) {
  if (!value || typeof value !== "object") return null;
  const name = String(value.name || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!name) return null;
  return { name, profileUrl: safeLinkedInUrl(value.profileUrl, "/in/") };
}

function createStatus(kind, code, message, observedContact = null) {
  return {
    source: "chathelp-linkedin-extension",
    version: 2,
    statusId: `status-${crypto.randomUUID()}`,
    occurredAt: new Date().toISOString(),
    kind: kind === "success" ? "success" : kind === "error" ? "error" : "info",
    code: String(code || "sync_status").slice(0, 100),
    message: String(message || "DialogMint automatic sync status changed.").replace(/\s+/g, " ").trim().slice(0, 1_000),
    observedContact: normalizeObservedContact(observedContact),
  };
}

function isLinkedInConversation(url) {
  try {
    const parsed = new URL(url || "");
    return parsed.protocol === "https:" && (parsed.hostname === "linkedin.com" || parsed.hostname === "www.linkedin.com") && parsed.pathname.startsWith("/messaging/");
  } catch {
    return false;
  }
}

function isAppSender(sender) {
  return typeof sender?.url === "string" && APP_URLS.some((appUrl) => sender.url.startsWith(appUrl));
}

async function showBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
  if (text && text !== "ON" && text !== "II") setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => undefined), 8_000);
}

async function queryAppTabs() {
  return chrome.tabs.query({ url: APP_URLS.map((appUrl) => `${appUrl}*`) });
}

async function sendStatusToApp(status) {
  const tabs = await queryAppTabs();
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, { type: STATUS_EVENT, status }).catch(() => undefined)));
  return tabs.length;
}

async function sendSnapshotToApp(snapshot) {
  const tabs = await queryAppTabs();
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, { type: SNAPSHOT_EVENT, snapshot }).catch(() => undefined)));
  return tabs.length;
}

async function openOrFocusChatHelp(snapshot, status) {
  const tabs = await queryAppTabs();
  const existing = tabs[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === "number") await chrome.windows.update(existing.windowId, { focused: true });
    if (status) chrome.tabs.sendMessage(existing.id, { type: STATUS_EVENT, status }).catch(() => undefined);
    if (snapshot) chrome.tabs.sendMessage(existing.id, { type: SNAPSHOT_EVENT, snapshot }).catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url: PRODUCTION_APP_URL });
}

async function permissionGranted() {
  return chrome.permissions.contains({ origins: [LINKEDIN_ORIGIN] });
}

async function readSyncState(codeOverride = "", messageOverride = "") {
  const [stored, granted, session] = await Promise.all([
    chrome.storage.local.get([SYNC_ENABLED_KEY, SYNC_PAUSED_KEY]),
    permissionGranted(),
    chrome.storage.session.get([LAST_CONTACT_KEY, LAST_MESSAGE_COUNT_KEY]),
  ]);
  const requestedEnabled = stored[SYNC_ENABLED_KEY] === true;
  const enabled = requestedEnabled && granted;
  const paused = enabled && stored[SYNC_PAUSED_KEY] === true;
  let code = codeOverride;
  let message = messageOverride;
  if (!code) {
    if (requestedEnabled && !granted) {
      code = "permission_removed";
      message = "Permission removed. Automatic LinkedIn sync has stopped.";
    } else if (!enabled) {
      code = granted ? "automatic_sync_disabled" : "permission_required";
      message = granted ? "Automatic sync disabled." : "Permission required to enable automatic LinkedIn conversation sync.";
    } else if (paused) {
      code = "sync_paused";
      message = "Sync paused.";
    } else {
      code = "waiting_for_conversation";
      message = "Waiting for a LinkedIn conversation you manually open.";
    }
  }
  return {
    source: "chathelp-linkedin-extension",
    version: 1,
    stateId: `state-${crypto.randomUUID()}`,
    occurredAt: new Date().toISOString(),
    enabled,
    paused,
    permissionGranted: granted,
    code,
    message,
    lastContactName: String(session[LAST_CONTACT_KEY] || "").slice(0, 200),
    lastMessageCount: Number.isFinite(session[LAST_MESSAGE_COUNT_KEY]) ? Math.max(0, Math.floor(session[LAST_MESSAGE_COUNT_KEY])) : 0,
  };
}

async function ensureSyncContentScript() {
  if (syncContentScriptRegistration) return syncContentScriptRegistration;
  const operation = (async () => {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SYNC_SCRIPT_ID] });
    if (registered.length) return;
    await chrome.scripting.registerContentScripts([{
      id: SYNC_SCRIPT_ID,
      matches: [LINKEDIN_MESSAGING],
      js: ["extractor.js", "linkedin-sync.js"],
      runAt: "document_idle",
      world: "ISOLATED",
      persistAcrossSessions: true,
    }]);
  })();
  syncContentScriptRegistration = operation;
  try {
    await operation;
  } finally {
    if (syncContentScriptRegistration === operation) syncContentScriptRegistration = null;
  }
}

async function removeSyncContentScript() {
  await chrome.scripting.unregisterContentScripts({ ids: [SYNC_SCRIPT_ID] }).catch(() => undefined);
}

async function messagingTabs() {
  return chrome.tabs.query({ url: LINKEDIN_MESSAGING });
}

async function broadcastLinkedInState(state) {
  const tabs = await messagingTabs().catch(() => []);
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, { type: SYNC_STATE_CHANGED, state }).catch(() => undefined)));
}

async function publishState(state) {
  const tabs = await queryAppTabs();
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.tabs.sendMessage(tab.id, { type: SYNC_STATE_EVENT, state }).catch(() => undefined)));
  await broadcastLinkedInState(state);
  await showBadge(state.enabled ? state.paused ? "II" : "ON" : "", state.paused ? "#8a6417" : "#245f47", state.message);
  return state;
}

async function injectSyncIntoOpenMessagingTabs() {
  const tabs = await messagingTabs();
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["extractor.js", "linkedin-sync.js"],
    world: "ISOLATED",
  }).catch(() => undefined)));
}

async function enableAutomaticSync() {
  // This is intentionally the first awaited API call. The app bridge forwards
  // the user's button gesture so Chrome can display its own permission prompt.
  const granted = await chrome.permissions.request({ origins: [LINKEDIN_ORIGIN] });
  if (!granted) return publishState(await readSyncState("permission_required", "Permission was not granted. Automatic sync remains off."));
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: true, [SYNC_PAUSED_KEY]: false });
  await ensureSyncContentScript();
  await injectSyncIntoOpenMessagingTabs();
  return publishState(await readSyncState("waiting_for_conversation", "Automatic sync enabled. Waiting for a LinkedIn conversation you manually open."));
}

async function pauseAutomaticSync() {
  const state = await readSyncState();
  if (!state.enabled) return publishState(state);
  await chrome.storage.local.set({ [SYNC_PAUSED_KEY]: true });
  return publishState(await readSyncState("sync_paused", "Sync paused."));
}

async function resumeAutomaticSync() {
  if (!await permissionGranted()) {
    await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: false, [SYNC_PAUSED_KEY]: false });
    return publishState(await readSyncState("permission_removed", "Permission removed. Enable automatic sync again to continue."));
  }
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: true, [SYNC_PAUSED_KEY]: false });
  await ensureSyncContentScript();
  await injectSyncIntoOpenMessagingTabs();
  return publishState(await readSyncState("waiting_for_conversation", "Automatic sync resumed. Waiting for a LinkedIn conversation you manually open."));
}

async function disableAutomaticSync() {
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: false, [SYNC_PAUSED_KEY]: false });
  const stoppingState = await readSyncState("automatic_sync_disabled", "Automatic sync disabled and LinkedIn permission revoked.");
  await broadcastLinkedInState(stoppingState);
  await removeSyncContentScript();
  await chrome.permissions.remove({ origins: [LINKEDIN_ORIGIN] });
  return publishState(await readSyncState("automatic_sync_disabled", "Automatic sync disabled and LinkedIn permission revoked."));
}

async function restoreSyncRegistration() {
  const state = await readSyncState();
  if (state.enabled) {
    await ensureSyncContentScript();
    await injectSyncIntoOpenMessagingTabs();
  } else await removeSyncContentScript();
  await publishState(state);
}

function restoreSyncRegistrationSafely() {
  if (syncRestoreOperation) return;
  const operation = restoreSyncRegistration();
  syncRestoreOperation = operation;
  void operation.catch(() => undefined).finally(() => {
    if (syncRestoreOperation === operation) syncRestoreOperation = null;
  });
}

async function reportManualFailure(code, message, observedContact = null) {
  const status = createStatus("error", code, message, observedContact);
  await chrome.storage.session.set({ [MANUAL_STATUS_KEY]: status });
  await showBadge("!", "#a33a2b", status.message);
  await openOrFocusChatHelp(null, status);
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab.id || !isLinkedInConversation(tab.url)) {
      await reportManualFailure("not_linkedin_conversation", "Open a LinkedIn Messaging conversation, then click DialogMint for a one-time capture.");
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: globalThis.extractOpenLinkedInConversation,
      args: ["manual"],
    });
    const extraction = results[0]?.result;
    if (!extraction?.ok) {
      await reportManualFailure(extraction?.error?.code || "capture_error", extraction?.error?.message || "DialogMint could not capture this conversation.", extraction?.error?.observedContact || null);
      return;
    }
    const snapshot = extraction.snapshot;
    const status = createStatus("success", "manual_capture_complete", `Captured ${snapshot.messages.length} visible message${snapshot.messages.length === 1 ? "" : "s"} for ${snapshot.contact.name}.`);
    await chrome.storage.session.set({ [MANUAL_SNAPSHOT_KEY]: snapshot, [MANUAL_STATUS_KEY]: status });
    await showBadge("OK", "#245f47", status.message);
    await openOrFocusChatHelp(snapshot, status);
  } catch (error) {
    await reportManualFailure("unexpected_capture_error", error instanceof Error ? error.message : "DialogMint could not capture this conversation.");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CHATHELP_LINKEDIN_SYNC_COMMAND" && isAppSender(sender)) {
    const operation = message.command === "enable" ? enableAutomaticSync()
      : message.command === "pause" ? pauseAutomaticSync()
      : message.command === "resume" ? resumeAutomaticSync()
      : message.command === "disable" ? disableAutomaticSync()
      : readSyncState().then(publishState);
    operation.then((state) => sendResponse({ ok: true, state })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Sync control failed." }));
    return true;
  }
  if (message?.type === "CHATHELP_GET_SYNC_STATE") {
    readSyncState().then((state) => sendResponse(state)).catch(() => sendResponse(null));
    return true;
  }
  if (message?.type === "CHATHELP_GET_PENDING_CAPTURE" && isAppSender(sender)) {
    chrome.storage.session.get([MANUAL_SNAPSHOT_KEY, MANUAL_STATUS_KEY]).then((result) => sendResponse({
      snapshot: result[MANUAL_SNAPSHOT_KEY] || null,
      status: result[MANUAL_STATUS_KEY] || null,
    }));
    return true;
  }
  if (message?.type === "CHATHELP_ACK_PENDING_SNAPSHOT" && typeof message.captureId === "string" && isAppSender(sender)) {
    chrome.storage.session.get(MANUAL_SNAPSHOT_KEY).then(async (result) => {
      if (result[MANUAL_SNAPSHOT_KEY]?.captureId === message.captureId) await chrome.storage.session.remove(MANUAL_SNAPSHOT_KEY);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message?.type === "CHATHELP_ACK_PENDING_STATUS" && typeof message.statusId === "string" && isAppSender(sender)) {
    chrome.storage.session.get(MANUAL_STATUS_KEY).then(async (result) => {
      if (result[MANUAL_STATUS_KEY]?.statusId === message.statusId) await chrome.storage.session.remove(MANUAL_STATUS_KEY);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message?.type === "CHATHELP_AUTO_SYNC_STATUS" && isLinkedInConversation(sender?.tab?.url || sender?.url)) {
    readSyncState().then(async (state) => {
      if (!state.enabled || state.paused) {
        sendResponse({ ok: false, ignored: true });
        return;
      }
      const errorCodes = new Set(["conversation_not_found", "contact_header_not_found", "contact_name_not_found", "messages_not_found", "linkedin_layout_unsupported"]);
      const status = createStatus(errorCodes.has(message.code) ? "error" : "info", message.code, message.message, message.observedContact || null);
      await sendStatusToApp(status);
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Status handoff failed." }));
    return true;
  }
  if (message?.type === "CHATHELP_AUTO_SYNC_SNAPSHOT" && isLinkedInConversation(sender?.tab?.url || sender?.url)) {
    readSyncState().then(async (state) => {
      if (!state.enabled || state.paused || !message.snapshot || message.snapshot.captureMode !== "automatic") {
        sendResponse({ ok: false, ignored: true });
        return;
      }
      const snapshot = message.snapshot;
      const delivered = await sendSnapshotToApp(snapshot);
      if (!delivered) {
        await showBadge("APP", "#8a6417", "Open DialogMint to receive synchronized conversations.");
        sendResponse({ ok: false, delivered: false });
        return;
      }
      await chrome.storage.session.set({
        [LAST_CONTACT_KEY]: String(snapshot.contact?.name || "").slice(0, 200),
        [LAST_MESSAGE_COUNT_KEY]: Array.isArray(snapshot.messages) ? snapshot.messages.length : 0,
      });
      const nextState = await readSyncState("conversation_synchronized", `Synchronized ${snapshot.contact?.name || "the open contact"} and ${snapshot.messages?.length || 0} visible messages.`);
      await publishState(nextState);
      sendResponse({ ok: true, delivered: true });
    }).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Snapshot handoff failed." }));
    return true;
  }
  return false;
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (!(permissions.origins || []).includes(LINKEDIN_ORIGIN)) return;
  chrome.storage.local.set({ [SYNC_ENABLED_KEY]: false, [SYNC_PAUSED_KEY]: false }).then(async () => {
    await removeSyncContentScript();
    const state = await readSyncState("permission_removed", "Permission removed. Automatic LinkedIn sync has stopped.");
    await publishState(state);
    await sendStatusToApp(createStatus("error", "permission_removed", state.message));
  }).catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(restoreSyncRegistrationSafely);
chrome.runtime.onStartup.addListener(restoreSyncRegistrationSafely);
restoreSyncRegistrationSafely();
