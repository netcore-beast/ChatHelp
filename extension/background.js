importScripts("extractor.js");

const APP_URL = "https://chathelp-private-cloud.project-mission-ai.workers.dev/";
const SNAPSHOT_KEY = "pendingLinkedInSnapshot";
const STATUS_KEY = "pendingLinkedInCaptureStatus";
const SELECTED_CONTACT_KEY = "selectedLinkedInContact";
const SNAPSHOT_EVENT = "CHATHELP_LINKEDIN_SNAPSHOT";
const STATUS_EVENT = "CHATHELP_LINKEDIN_EXTENSION_STATUS";
const SELECTED_CONTACT_EVENT = "CHATHELP_SET_SELECTED_LINKEDIN_CONTACT";

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

function normalizeSelectedContact(value) {
  if (!value || typeof value !== "object") return null;
  const contactId = String(value.contactId || "").trim().slice(0, 200);
  const name = String(value.name || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const profileUrl = safeLinkedInUrl(value.profileUrl, "/in/");
  return contactId && name ? { contactId, name, profileUrl } : null;
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
    version: 1,
    statusId: `status-${crypto.randomUUID()}`,
    occurredAt: new Date().toISOString(),
    kind: kind === "success" ? "success" : "error",
    code: String(code || "capture_error").slice(0, 100),
    message: String(message || "ChatHelp could not capture this conversation.").replace(/\s+/g, " ").trim().slice(0, 1_000),
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

async function showBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => undefined), 8_000);
}

async function openOrFocusChatHelp(snapshot, status) {
  const matches = await chrome.tabs.query({ url: `${APP_URL}*` });
  const existing = matches[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === "number") await chrome.windows.update(existing.windowId, { focused: true });
    if (status) chrome.tabs.sendMessage(existing.id, { type: STATUS_EVENT, status }).catch(() => undefined);
    if (snapshot) chrome.tabs.sendMessage(existing.id, { type: SNAPSHOT_EVENT, snapshot }).catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
}

async function reportFailure(code, message, observedContact = null) {
  const status = createStatus("error", code, message, observedContact);
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  await showBadge("!", "#a33a2b", status.message);
  await openOrFocusChatHelp(null, status);
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab.id || !isLinkedInConversation(tab.url)) {
      await reportFailure("not_linkedin_conversation", "Open a LinkedIn Messaging conversation, then click ChatHelp again.");
      return;
    }
    const stored = await chrome.storage.session.get(SELECTED_CONTACT_KEY);
    const selectedContact = normalizeSelectedContact(stored[SELECTED_CONTACT_KEY]);
    if (!selectedContact) {
      await reportFailure("contact_not_selected", "Add and select a LinkedIn contact in ChatHelp before capturing messages.");
      return;
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: globalThis.extractOpenLinkedInConversation,
      args: [selectedContact],
    });
    const extraction = results[0]?.result;
    if (!extraction?.ok) {
      await reportFailure(
        extraction?.error?.code || "capture_error",
        extraction?.error?.message || "ChatHelp could not capture this conversation.",
        extraction?.error?.observedContact || null,
      );
      return;
    }
    const snapshot = extraction.snapshot;
    if (!snapshot?.messages?.length) {
      await reportFailure("messages_not_found", "No visible LinkedIn messages were captured. Keep at least one message visible and try again.", snapshot?.contact);
      return;
    }
    const status = createStatus("success", "capture_complete", `Captured ${snapshot.messages.length} visible message${snapshot.messages.length === 1 ? "" : "s"} for ${snapshot.contact.name}.`);
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot, [STATUS_KEY]: status });
    await showBadge("OK", "#245f47", status.message);
    await openOrFocusChatHelp(snapshot, status);
  } catch (error) {
    await reportFailure("unexpected_capture_error", error instanceof Error ? error.message : "ChatHelp could not capture this conversation.");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === SELECTED_CONTACT_EVENT) {
    const selectedContact = normalizeSelectedContact(message.contact);
    const operation = selectedContact
      ? chrome.storage.session.set({ [SELECTED_CONTACT_KEY]: selectedContact })
      : chrome.storage.session.remove(SELECTED_CONTACT_KEY);
    operation.then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "CHATHELP_GET_PENDING_CAPTURE") {
    chrome.storage.local.get([SNAPSHOT_KEY, STATUS_KEY]).then((result) => sendResponse({
      snapshot: result[SNAPSHOT_KEY] || null,
      status: result[STATUS_KEY] || null,
    }));
    return true;
  }
  if (message?.type === "CHATHELP_ACK_PENDING_SNAPSHOT" && typeof message.captureId === "string") {
    chrome.storage.local.get(SNAPSHOT_KEY).then(async (result) => {
      if (result[SNAPSHOT_KEY]?.captureId === message.captureId) await chrome.storage.local.remove(SNAPSHOT_KEY);
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message?.type === "CHATHELP_ACK_PENDING_STATUS" && typeof message.statusId === "string") {
    chrome.storage.local.get(STATUS_KEY).then(async (result) => {
      if (result[STATUS_KEY]?.statusId === message.statusId) await chrome.storage.local.remove(STATUS_KEY);
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
