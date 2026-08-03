const SOURCE = "chathelp-linkedin-extension";
const REQUEST = "CHATHELP_REQUEST_LINKEDIN_SNAPSHOT";
const SNAPSHOT = "CHATHELP_LINKEDIN_SNAPSHOT";
const STATUS = "CHATHELP_LINKEDIN_EXTENSION_STATUS";
const ACK = "CHATHELP_ACK_LINKEDIN_SNAPSHOT";
const STATUS_ACK = "CHATHELP_ACK_LINKEDIN_EXTENSION_STATUS";
const SELECT_CONTACT = "CHATHELP_SET_SELECTED_LINKEDIN_CONTACT";

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

function reportBridgeError(error) {
  deliverStatus({
    source: SOURCE,
    version: 1,
    statusId: `bridge-${Date.now()}`,
    occurredAt: new Date().toISOString(),
    kind: "error",
    code: "extension_bridge_error",
    message: error instanceof Error ? error.message : "The ChatHelp extension bridge could not reach its background service. Reload the extension and this ChatHelp tab.",
    observedContact: null,
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin || !event.data || event.data.source !== "chathelp-app") return;
  if (event.data.type === REQUEST) {
    announceReady();
    chrome.runtime.sendMessage({ type: "CHATHELP_GET_PENDING_CAPTURE" }).then((response) => {
      deliverStatus(response?.status);
      deliver(response?.snapshot);
    }).catch(reportBridgeError);
  }
  if (event.data.type === SELECT_CONTACT) {
    chrome.runtime.sendMessage({ type: SELECT_CONTACT, contact: event.data.contact ?? null }).catch(reportBridgeError);
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
});

announceReady();
