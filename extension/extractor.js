globalThis.extractOpenLinkedInConversation = function extractOpenLinkedInConversation(captureMode = "manual") {
  const cleanText = (value, limit = 20_000) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  };
  const firstElement = (root, selectors) => {
    for (const selector of selectors) {
      for (const candidate of root.querySelectorAll(selector)) {
        if (visible(candidate)) return candidate;
      }
    }
    return null;
  };
  const firstText = (root, selectors, limit) => {
    for (const selector of selectors) {
      for (const candidate of root.querySelectorAll(selector)) {
        const value = cleanText(candidate.textContent, limit);
        if (visible(candidate) && value && !/^(messaging|messages|details)$/i.test(value)) return value;
      }
    }
    return "";
  };
  const safeLinkedInUrl = (value, prefix) => {
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== "https:" || (url.hostname !== "linkedin.com" && url.hostname !== "www.linkedin.com") || !url.pathname.startsWith(prefix)) return "";
      url.hostname = "www.linkedin.com";
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
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
  const normalized = (value) => cleanText(value, 20_000).normalize("NFKC").toLocaleLowerCase();
  const personName = (value) => cleanText(value, 300)
    .replace(/^view\s+/i, "")
    .replace(/[’']s\s+(?:linkedin\s+)?profile.*$/i, "")
    .replace(/\s+(?:view\s+profile|profile)$/i, "")
    .replace(/\s*[•·]\s*(?:1st|2nd|3rd)(?:\s+degree)?(?:\s+connection)?(?:\s*.*)?$/i, "")
    .replace(/\s+(?:online|active\s+now)$/i, "")
    .trim()
    .slice(0, 200);
  const hash = (value) => {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };
  const failure = (code, message, observedContact = null) => ({ ok: false, error: { code, message, observedContact } });

  // Start from LinkedIn's central application region. Overlay chats, inbox
  // previews, and complementary side panels can contain similar message
  // markup, but are intentionally outside this root.
  const centralRoot = firstElement(document, [
    ".scaffold-layout__main",
    "main",
    "[role='main']",
  ]);
  if (!centralRoot) return failure("conversation_not_found", "No conversation open. Open a LinkedIn Messaging conversation and keep its header and at least one message visible.");

  // Every message query below is scoped to this one visible central container.
  const thread = firstElement(centralRoot, [
    ".msg-s-message-list-container",
    ".msg-s-message-list",
    ".msg-thread",
    ".msg-convo-wrapper [data-view-name='message-thread-list']",
    "[data-view-name='message-thread-list']",
    "[data-view-name='conversation-thread']",
  ]);
  if (!thread) return failure("conversation_not_found", "No conversation open. Open a LinkedIn Messaging conversation and keep its header and at least one message visible.");

  const conversationRoot = thread.closest(".msg-convo-wrapper, .msg-thread, [data-view-name='message-thread'], [data-view-name='conversation-view'], main, [role='main']") || centralRoot;
  const header = firstElement(conversationRoot, [
    ".msg-thread__top-card",
    ".msg-convo-wrapper__top-card",
    "[data-view-name='message-thread-header']",
    "[data-view-name='conversation-header']",
    ".msg-entity-lockup",
  ]);
  if (!header) return failure("contact_header_not_found", "LinkedIn layout unsupported. ChatHelp could not find the open conversation header.");

  // Identity is read and validated before any message node is queried.
  const profileAnchor = firstElement(header, ["a[href*='/in/']", ".msg-thread__link-to-profile"]);
  const rawName = firstText(header, [
    "[data-anonymize='person-name']",
    ".msg-thread__link-to-profile [aria-hidden='true']",
    ".msg-entity-lockup__entity-title",
    ".msg-overlay-bubble-header__title",
    ".artdeco-entity-lockup__title",
    ".msg-thread__link-to-profile",
    "h2",
  ], 300) || profileAnchor?.getAttribute("aria-label") || profileAnchor?.getAttribute("title") || "";
  const name = personName(rawName);
  if (!name) return failure("contact_name_not_found", "LinkedIn layout unsupported. ChatHelp could not identify the open conversation contact.");

  const headline = firstText(header, [
    ".msg-entity-lockup__entity-subtitle",
    ".artdeco-entity-lockup__subtitle",
    ".msg-thread__participant-info",
    "[data-view-name='message-thread-subtitle']",
  ], 500);
  const explicitCompany = firstText(header, ["[data-view-name='message-thread-company']", "[data-anonymize='company-name']"], 500);
  const company = explicitCompany || cleanText(headline.match(/\bat\s+(.+)$/i)?.[1] || "", 500);
  const avatar = firstElement(header, ["img.msg-entity-lockup__entity-image", "img.presence-entity__image", "img"]);
  const profileUrl = safeLinkedInUrl(profileAnchor?.getAttribute("href") || "", "/in/");
  const avatarUrl = safeImageUrl(avatar?.getAttribute("src") || "");
  const observedContact = { name, profileUrl };
  const pageUrl = safeLinkedInUrl(`${location.origin}${location.pathname}`, "/messaging/");
  const contactIdentity = profileUrl || pageUrl || normalized(name);

  const eventNodes = Array.from(thread.querySelectorAll([
    ".msg-s-message-list__event",
    ".msg-s-event-listitem",
    "[data-event-urn]",
    "[data-view-name='message-event']",
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
      ".msg-s-event-listitem__message-bubble",
      ".msg-s-message-group__message-bubble",
      ".msg-s-message-list__event-content [dir='ltr']",
      ".msg-s-message-list__event-content",
      "[data-view-name='message-bubble']",
      "[data-view-name='message-body']",
      "p",
    ]);
    const body = cleanText(bodyElement?.textContent || "", 20_000);
    const attachmentElements = Array.from(eventNode.querySelectorAll([
      ".msg-s-message-list__attachment",
      ".msg-s-event-listitem__attachment",
      "[data-view-name='message-attachment']",
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
      "[data-view-name='message-sender']",
    ], 200) || lastSpeaker;
    if (speaker) lastSpeaker = speaker;
    const ownSelector = ".msg-s-message-list__event--own, .msg-s-message-group--self, .msg-s-event-listitem--self, [data-is-own-message='true'], [data-sender-is-viewer='true']";
    const own = eventNode.matches(ownSelector) || Boolean(eventNode.querySelector(ownSelector));
    const normalizedSpeaker = normalized(speaker);
    const role = own || normalizedSpeaker === "you" || (normalizedSpeaker && normalizedSpeaker !== normalized(name)) ? "me" : "them";
    const timeElement = eventNode.querySelector("time, [datetime], .msg-s-message-group__timestamp, .msg-s-event-listitem__time-stamp");
    const rawDate = timeElement?.getAttribute("datetime") || "";
    const parsedDate = rawDate && !Number.isNaN(new Date(rawDate).getTime()) ? new Date(rawDate).toISOString() : "";
    const sourceId = cleanText(eventNode.getAttribute("data-event-urn") || eventNode.id, 200);
    const fingerprint = [contactIdentity, role, normalized(speaker), normalized(body), parsedDate, attachments.map((item) => normalized(item.label)).join("|")].join("|");
    if (seenMessages.has(sourceId || fingerprint)) return;
    seenMessages.add(sourceId || fingerprint);
    messages.push({
      id: sourceId || `visible-message-${hash(fingerprint)}`,
      sourceId,
      role,
      speaker,
      body,
      createdAt: parsedDate,
      attachments,
    });
  });

  if (!messages.length) return failure("messages_not_found", "No visible messages were found in the open central conversation.", observedContact);
  return {
    ok: true,
    snapshot: {
      source: "chathelp-linkedin-extension",
      version: 2,
      captureMode: captureMode === "automatic" ? "automatic" : "manual",
      captureId: `capture-${crypto.randomUUID()}`,
      capturedAt: new Date().toISOString(),
      pageUrl,
      contact: { name, headline, company, profileUrl, avatarUrl },
      messages,
    },
  };
};
