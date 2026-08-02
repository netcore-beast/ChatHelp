const APP_URL = "https://chathelp-private-cloud.project-mission-ai.workers.dev/";
const SNAPSHOT_KEY = "pendingLinkedInSnapshot";
const SELECTED_CONTACT_KEY = "selectedLinkedInContact";
const SNAPSHOT_EVENT = "CHATHELP_LINKEDIN_SNAPSHOT";
const SELECTED_CONTACT_EVENT = "CHATHELP_SET_SELECTED_LINKEDIN_CONTACT";

function normalizeSelectedContact(value) {
  if (!value || typeof value !== "object") return null;
  const contactId = String(value.contactId || "").trim().slice(0, 200);
  const name = String(value.name || "").replace(/\s+/g, " ").trim().slice(0, 200);
  let profileUrl = "";
  try {
    const parsed = new URL(String(value.profileUrl || ""));
    if (parsed.protocol === "https:" && (parsed.hostname === "linkedin.com" || parsed.hostname === "www.linkedin.com") && parsed.pathname.startsWith("/in/")) {
      parsed.hostname = "www.linkedin.com";
      parsed.search = "";
      parsed.hash = "";
      profileUrl = parsed.toString();
    }
  } catch { /* A profile URL is optional; exact contact-name matching remains required. */ }
  return contactId && name ? { contactId, name, profileUrl } : null;
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
  if (text) setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => undefined), 4_000);
}

async function openOrFocusChatHelp(snapshot) {
  const matches = await chrome.tabs.query({ url: `${APP_URL}*` });
  const existing = matches[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === "number") await chrome.windows.update(existing.windowId, { focused: true });
    chrome.tabs.sendMessage(existing.id, { type: SNAPSHOT_EVENT, snapshot }).catch(() => undefined);
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
}

function extractOpenLinkedInConversation(expectedContact) {
  const cleanText = (value, limit = 20_000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const firstText = (root, selectors, limit) => {
    for (const selector of selectors) {
      const candidates = root.querySelectorAll(selector);
      for (const candidate of candidates) {
        const value = cleanText(candidate.textContent, limit);
        if (visible(candidate) && value && !/^(messaging|messages|details)$/i.test(value)) return value;
      }
    }
    return "";
  };
  const firstElement = (root, selectors) => {
    for (const selector of selectors) {
      const candidate = root.querySelector(selector);
      if (candidate && visible(candidate)) return candidate;
    }
    return null;
  };
  const safeLinkedInUrl = (value, prefix) => {
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== "https:" || (url.hostname !== "linkedin.com" && url.hostname !== "www.linkedin.com") || !url.pathname.startsWith(prefix)) return "";
      url.hostname = "www.linkedin.com";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "";
    }
  };
  const safeImageUrl = (value) => {
    try {
      const url = new URL(value || "");
      if (url.protocol !== "https:" || (url.hostname !== "linkedin.com" && !url.hostname.endsWith(".linkedin.com") && !url.hostname.endsWith(".licdn.com"))) return "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "";
    }
  };
  const hash = (value) => {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };

  const thread = firstElement(document, [
    ".msg-s-message-list-container",
    ".msg-thread",
    ".msg-convo-wrapper",
    "[data-view-name='message-thread']",
    "[data-view-name='message-thread-list']",
  ]);
  if (!thread) throw new Error("Open a LinkedIn Messaging conversation before capturing it.");

  const header = firstElement(document, [
    ".msg-thread__top-card",
    ".msg-overlay-bubble-header",
    ".msg-entity-lockup",
    "main header",
  ]) || thread;
  const name = firstText(header, [
    ".msg-thread__link-to-profile",
    ".msg-entity-lockup__entity-title",
    ".msg-overlay-bubble-header__title",
    ".artdeco-entity-lockup__title",
    "h2",
  ], 200);
  if (!name) throw new Error("ChatHelp could not identify the selected LinkedIn contact. Keep the conversation header visible and try again.");

  const headline = firstText(header, [
    ".msg-entity-lockup__entity-subtitle",
    ".artdeco-entity-lockup__subtitle",
    ".msg-thread__participant-info",
  ], 500);
  const profileAnchor = firstElement(header, ["a[href*='/in/']", ".msg-thread__link-to-profile"]);
  const avatar = firstElement(header, ["img.msg-entity-lockup__entity-image", "img.presence-entity__image", "img"]);
  const profileUrl = safeLinkedInUrl(profileAnchor?.getAttribute("href") || "", "/in/");
  const avatarUrl = safeImageUrl(avatar?.getAttribute("src") || "");
  const expectedName = cleanText(expectedContact?.name, 200);
  const expectedProfileUrl = safeLinkedInUrl(expectedContact?.profileUrl || "", "/in/");
  const namesMatch = name.toLowerCase() === expectedName.toLowerCase();
  const identityMatches = expectedProfileUrl && profileUrl ? expectedProfileUrl === profileUrl : namesMatch;
  if (!expectedName || !identityMatches) {
    throw new Error(`ChatHelp is locked to ${expectedName || "the selected contact"}. Open that contact's conversation before capturing.`);
  }
  const capturedAt = new Date().toISOString();
  const eventNodes = Array.from(thread.querySelectorAll([
    "li.msg-s-message-list__event",
    ".msg-s-event-listitem",
    "[data-event-urn]",
  ].join(","))).filter(visible);
  const seenNodes = new Set();
  const seenMessages = new Set();
  const messages = [];
  let lastSpeaker = "";

  eventNodes.forEach((eventNode, index) => {
    if (seenNodes.has(eventNode)) return;
    seenNodes.add(eventNode);
    const bodyElement = firstElement(eventNode, [
      ".msg-s-event-listitem__body",
      ".msg-s-message-group__message-bubble",
      ".msg-s-message-list__event-content",
      "p",
    ]);
    const body = cleanText(bodyElement?.textContent || "", 20_000);
    const attachmentElements = Array.from(eventNode.querySelectorAll([
      ".msg-s-message-list__attachment",
      ".msg-s-event-listitem__attachment",
      "a[href*='/messaging/attachments']",
    ].join(","))).filter(visible);
    const attachments = attachmentElements.slice(0, 20).map((attachment, attachmentIndex) => {
      const label = cleanText(attachment.getAttribute("aria-label") || attachment.textContent || "Visible attachment", 300) || "Visible attachment";
      const kind = attachment.querySelector("img") || /image|photo/i.test(label) ? "image" : attachment instanceof HTMLAnchorElement ? "link" : "file";
      return { id: `attachment-${index}-${attachmentIndex}-${hash(label)}`, label, kind };
    });
    if (!body && !attachments.length) return;

    const speaker = firstText(eventNode, [
      ".msg-s-message-group__name",
      ".msg-s-event-listitem__actor-name",
      ".msg-s-message-list__profile-link",
    ], 200) || lastSpeaker;
    if (speaker) lastSpeaker = speaker;
    const own = eventNode.matches(".msg-s-message-list__event--own, [data-is-own-message='true']") || Boolean(eventNode.querySelector(".msg-s-message-list__event--own, [data-is-own-message='true']"));
    const normalizedSpeaker = cleanText(speaker, 200).toLowerCase();
    const role = own || normalizedSpeaker === "you" || (normalizedSpeaker && normalizedSpeaker !== name.toLowerCase()) ? "me" : "them";
    const timeElement = eventNode.querySelector("time, [datetime], .msg-s-message-group__timestamp, .msg-s-event-listitem__time-stamp");
    const rawDate = timeElement?.getAttribute("datetime") || "";
    const parsedDate = rawDate && !Number.isNaN(new Date(rawDate).getTime()) ? new Date(rawDate).toISOString() : "";
    const sourceId = cleanText(eventNode.getAttribute("data-event-urn") || eventNode.id, 200);
    const fingerprint = `${role}|${body.toLowerCase()}|${parsedDate}|${attachments.map((item) => item.label).join("|")}`;
    if (seenMessages.has(fingerprint)) return;
    seenMessages.add(fingerprint);
    messages.push({
      id: sourceId || `visible-message-${hash(fingerprint)}`,
      role,
      speaker,
      body,
      createdAt: parsedDate,
      attachments,
    });
  });

  if (!messages.length) throw new Error("No visible LinkedIn messages were found. Open the conversation and keep at least one message visible.");
  return {
    source: "chathelp-linkedin-extension",
    version: 1,
    captureId: `capture-${crypto.randomUUID()}`,
    capturedAt,
    pageUrl: safeLinkedInUrl(`${location.origin}${location.pathname}`, "/messaging/"),
    contact: { name, headline, profileUrl, avatarUrl },
    messages,
  };
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab.id || !isLinkedInConversation(tab.url)) {
      await showBadge("!", "#a33a2b", "Open a LinkedIn Messaging conversation, then click ChatHelp again.");
      return;
    }
    const stored = await chrome.storage.session.get(SELECTED_CONTACT_KEY);
    const selectedContact = normalizeSelectedContact(stored[SELECTED_CONTACT_KEY]);
    if (!selectedContact) {
      await showBadge("!", "#a33a2b", "Add and select a LinkedIn contact in ChatHelp before capturing messages.");
      return;
    }
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractOpenLinkedInConversation, args: [selectedContact] });
    const snapshot = results[0]?.result;
    if (!snapshot?.messages?.length) throw new Error("No visible conversation was captured.");
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
    await showBadge("✓", "#245f47", `Captured ${snapshot.messages.length} visible messages for ${snapshot.contact.name}.`);
    await openOrFocusChatHelp(snapshot);
  } catch (error) {
    await showBadge("!", "#a33a2b", error instanceof Error ? error.message : "ChatHelp could not capture this conversation.");
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
  if (message?.type === "CHATHELP_GET_PENDING_SNAPSHOT") {
    chrome.storage.local.get(SNAPSHOT_KEY).then((result) => sendResponse({ snapshot: result[SNAPSHOT_KEY] || null }));
    return true;
  }
  if (message?.type === "CHATHELP_ACK_PENDING_SNAPSHOT" && typeof message.captureId === "string") {
    chrome.storage.local.get(SNAPSHOT_KEY).then(async (result) => {
      if (result[SNAPSHOT_KEY]?.captureId === message.captureId) await chrome.storage.local.remove(SNAPSHOT_KEY);
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});
