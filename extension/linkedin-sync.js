(() => {
  if (globalThis.__chathelpLinkedInSyncV1) return;
  globalThis.__chathelpLinkedInSyncV1 = true;

  const GET_STATE = "CHATHELP_GET_SYNC_STATE";
  const STATE_CHANGED = "CHATHELP_LINKEDIN_SYNC_STATE_CHANGED";
  const AUTO_SNAPSHOT = "CHATHELP_AUTO_SYNC_SNAPSHOT";
  const AUTO_STATUS = "CHATHELP_AUTO_SYNC_STATUS";
  const DEBOUNCE_MS = 700;
  let stopped = false;
  let captureTimer = 0;
  let captureInProgress = false;
  let lastUrl = location.href;
  let lastSnapshotSignature = "";
  let lastFailureCode = "";

  const hash = (value) => {
    let result = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      result ^= value.charCodeAt(index);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  };

  const sendStatus = async (code, message, observedContact = null) => {
    try {
      await chrome.runtime.sendMessage({
        type: AUTO_STATUS,
        code,
        message,
        observedContact,
      });
    } catch {
      // Reloading an unpacked extension invalidates the previous isolated
      // content-script context. It cannot report through that same context.
    }
  };

  const snapshotSignature = (snapshot) => hash(JSON.stringify({
    pageUrl: snapshot.pageUrl,
    profileUrl: snapshot.contact?.profileUrl,
    name: snapshot.contact?.name,
    messages: (snapshot.messages || []).map((message) => [message.sourceId || message.id, message.role, message.speaker, message.body, message.createdAt, (message.attachments || []).map((item) => item.label)]),
  }));

  async function captureStableConversation() {
    if (stopped || captureInProgress || !location.pathname.startsWith("/messaging/")) return;
    captureInProgress = true;
    try {
      const state = await chrome.runtime.sendMessage({ type: GET_STATE });
      if (!state?.enabled || state.paused || !state.permissionGranted || stopped) return;
      await sendStatus("reading_visible_conversation", "Reading the visible open conversation.");
      const extraction = globalThis.extractOpenLinkedInConversation("automatic");
      if (!extraction?.ok) {
        const code = extraction?.error?.code || "linkedin_layout_unsupported";
        if (code !== lastFailureCode) {
          lastFailureCode = code;
          await sendStatus(code, extraction?.error?.message || "LinkedIn layout unsupported.", extraction?.error?.observedContact || null);
        }
        return;
      }
      lastFailureCode = "";
      const signature = snapshotSignature(extraction.snapshot);
      if (signature === lastSnapshotSignature) return;
      lastSnapshotSignature = signature;
      await chrome.runtime.sendMessage({ type: AUTO_SNAPSHOT, snapshot: extraction.snapshot });
    } catch {
      await sendStatus("sync_unavailable", "Automatic sync is waiting for the ChatHelp extension connection.");
    } finally {
      captureInProgress = false;
    }
  }

  function scheduleCapture() {
    if (stopped) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => void captureStableConversation(), DEBOUNCE_MS);
  }

  const observer = new MutationObserver(() => scheduleCapture());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // LinkedIn uses pushState and replaceState in its SPA. Isolated content
  // scripts do not patch page-owned functions, so URL polling plus relevant
  // DOM mutations detects those transitions without entering the main world.
  const routeTimer = setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    lastSnapshotSignature = "";
    lastFailureCode = "";
    scheduleCapture();
  }, 400);
  const routeChanged = () => {
    lastUrl = location.href;
    lastSnapshotSignature = "";
    lastFailureCode = "";
    scheduleCapture();
  };
  addEventListener("popstate", routeChanged);
  addEventListener("hashchange", routeChanged);
  if (globalThis.navigation?.addEventListener) globalThis.navigation.addEventListener("currententrychange", routeChanged);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== STATE_CHANGED) return;
    if (!message.state?.enabled || message.state?.paused || !message.state?.permissionGranted) {
      clearTimeout(captureTimer);
      if (!message.state?.enabled || !message.state?.permissionGranted) {
        stopped = true;
        observer.disconnect();
        clearInterval(routeTimer);
        removeEventListener("popstate", routeChanged);
        removeEventListener("hashchange", routeChanged);
        if (globalThis.navigation?.removeEventListener) globalThis.navigation.removeEventListener("currententrychange", routeChanged);
        delete globalThis.__chathelpLinkedInSyncV1;
      }
      return;
    }
    scheduleCapture();
  });

  scheduleCapture();
})();
