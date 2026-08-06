const SOURCE = "chathelp-linkedin-extension";
const REQUEST = "CHATHELP_REQUEST_LINKEDIN_SNAPSHOT";
const SNAPSHOT = "CHATHELP_LINKEDIN_SNAPSHOT";
const STATUS = "CHATHELP_LINKEDIN_EXTENSION_STATUS";
const ACK = "CHATHELP_ACK_LINKEDIN_SNAPSHOT";
const STATUS_ACK = "CHATHELP_ACK_LINKEDIN_EXTENSION_STATUS";
const SYNC_COMMAND = "CHATHELP_LINKEDIN_SYNC_COMMAND";
const SYNC_STATE = "CHATHELP_LINKEDIN_SYNC_STATE";

function announceReady() {
  let extensionVersion = "";
  try { extensionVersion = chrome.runtime.getManifest().version || ""; } catch { /* An invalidated extension context is reported below. */ }
  window.postMessage({ source: SOURCE, type: "CHATHELP_EXTENSION_READY", version: extensionVersion }, window.location.origin);
}

function deliver(snapshot) {
  if (!snapshot || snapshot.source !== SOURCE) return;
  window.postMessage({ source: SOURCE, type: SNAPSHOT, payload: snapshot }, window.location.origin);
}

function deliverStatus(status) {
  if (!status || status.source !== SOURCE) return;
  window.postMessage({ source: SOURCE, type: STATUS, payload: status }, window.location.origin);
}

function deliverSyncState(state) {
  if (!state || state.source !== SOURCE) return;
  window.postMessage({ source: SOURCE, type: SYNC_STATE, payload: state }, window.location.origin);
}

function reportBridgeError(error) {
  deliverStatus({
    source: SOURCE,
    version: 2,
    statusId: `bridge-${Date.now()}`,
    occurredAt: new Date().toISOString(),
    kind: "error",
    code: "extension_bridge_error",
    message: error instanceof Error ? error.message : "The DialogMint extension bridge could not reach its background service. Reload the extension and this DialogMint tab.",
    observedContact: null,
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin || !event.data || event.data.source !== "chathelp-app") return;
  if (event.data.type === REQUEST) {
    chrome.runtime.sendMessage({ type: "CHATHELP_GET_PENDING_CAPTURE" }).then((response) => {
      deliverStatus(response?.status);
      deliver(response?.snapshot);
    }).catch(reportBridgeError);
    chrome.runtime.sendMessage({ type: "CHATHELP_GET_SYNC_STATE" }).then(deliverSyncState).catch(reportBridgeError);
  }
  if (event.data.type === SYNC_COMMAND && ["enable", "pause", "resume", "disable", "refresh"].includes(event.data.command)) {
    // Keep this call directly inside the click-originated message handler so
    // Chrome can preserve the user gesture for permissions.request().
    chrome.runtime.sendMessage({ type: SYNC_COMMAND, command: event.data.command }).then((response) => {
      if (response?.state) deliverSyncState(response.state);
      if (!response?.ok) reportBridgeError(new Error(response?.error || "Sync control failed."));
    }).catch(reportBridgeError);
  }
  if (event.data.type === ACK && typeof event.data.captureId === "string") {
    chrome.runtime.sendMessage({ type: "CHATHELP_ACK_PENDING_SNAPSHOT", captureId: event.data.captureId }).catch(() => undefined);
  }
  if (event.data.type === STATUS_ACK && typeof event.data.statusId === "string") {
    chrome.runtime.sendMessage({ type: "CHATHELP_ACK_PENDING_STATUS", statusId: event.data.statusId }).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === SNAPSHOT) deliver(message.snapshot);
  if (message?.type === STATUS) deliverStatus(message.status);
  if (message?.type === SYNC_STATE) deliverSyncState(message.state);
});

announceReady();
