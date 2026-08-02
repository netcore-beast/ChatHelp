const SOURCE = "chathelp-linkedin-extension";
const REQUEST = "CHATHELP_REQUEST_LINKEDIN_SNAPSHOT";
const SNAPSHOT = "CHATHELP_LINKEDIN_SNAPSHOT";
const ACK = "CHATHELP_ACK_LINKEDIN_SNAPSHOT";

function deliver(snapshot) {
  if (!snapshot || snapshot.source !== SOURCE) return;
  window.postMessage({ source: SOURCE, type: SNAPSHOT, payload: snapshot }, window.location.origin);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin || !event.data || event.data.source !== "chathelp-app") return;
  if (event.data.type === REQUEST) {
    chrome.runtime.sendMessage({ type: "CHATHELP_GET_PENDING_SNAPSHOT" }).then((response) => deliver(response?.snapshot)).catch(() => undefined);
  }
  if (event.data.type === ACK && typeof event.data.captureId === "string") {
    chrome.runtime.sendMessage({ type: "CHATHELP_ACK_PENDING_SNAPSHOT", captureId: event.data.captureId }).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === SNAPSHOT) deliver(message.snapshot);
});

window.postMessage({ source: SOURCE, type: "CHATHELP_EXTENSION_READY" }, window.location.origin);
