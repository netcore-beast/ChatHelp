import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const background = await readFile("extension/background.js", "utf8");
const extractor = await readFile("extension/extractor.js", "utf8");
const syncScript = await readFile("extension/linkedin-sync.js", "utf8");
const bridge = await readFile("extension/app-bridge.js", "utf8");
const expectedPermissions = ["activeTab", "scripting", "storage"];
const expectedOptionalHosts = ["https://www.linkedin.com/*"];
const expectedAppHosts = [
  "https://chathelp-private-cloud.project-mission-ai.workers.dev/*",
  "https://testing-chathelp-private-cloud.project-mission-ai.workers.dev/*",
];

if (JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error("Chrome permissions must remain exactly activeTab, scripting, and storage.");
}
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(expectedOptionalHosts)) {
  throw new Error("Automatic sync must request only the optional LinkedIn host permission.");
}
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedAppHosts)) {
  throw new Error("The local app bridge must be limited to the exact production and testing ChatHelp hosts.");
}
if ((manifest.host_permissions ?? []).some((permission) => /linkedin\.com/i.test(permission))) {
  throw new Error("LinkedIn must remain optional and cannot be a required host permission.");
}
for (const forbiddenPermission of ["cookies", "debugger", "webRequest", "<all_urls>"]) {
  if ([...(manifest.permissions ?? []), ...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])].includes(forbiddenPermission)) {
    throw new Error("Forbidden extension permission present: " + forbiddenPermission);
  }
}
if (!background.includes("chrome.permissions.request({ origins: [LINKEDIN_ORIGIN] })") || !background.includes("chrome.permissions.remove({ origins: [LINKEDIN_ORIGIN] })")) {
  throw new Error("Enable and disable must explicitly grant and revoke the optional LinkedIn host permission.");
}
if (!background.includes("registerContentScripts") || !background.includes("unregisterContentScripts") || !background.includes('world: "ISOLATED"')) {
  throw new Error("Automatic sync must use a removable isolated Manifest V3 content script.");
}
if (!background.includes("chrome.action.onClicked") || !background.includes("extractOpenLinkedInConversation")) {
  throw new Error("The existing one-time action capture must remain available.");
}
if (!syncScript.includes("MutationObserver") || !syncScript.includes("popstate") || !syncScript.includes("pushState") || !syncScript.includes("replaceState")) {
  throw new Error("Automatic sync must debounce DOM and LinkedIn SPA navigation changes.");
}
if (!syncScript.includes("lastSnapshotSignature") || !syncScript.includes("state.paused")) {
  throw new Error("Automatic sync must deduplicate snapshots and stop reading while paused.");
}
if (extractor.indexOf("const observedContact") > extractor.indexOf("const eventNodes")) {
  throw new Error("The visible conversation identity must be read before message nodes.");
}
if (!extractor.includes("thread.querySelectorAll")) {
  throw new Error("Message extraction must remain scoped to the visible central thread.");
}
if (!background.includes("sendSnapshotToApp(snapshot)") || background.includes("[AUTO_SNAPSHOT]")) {
  throw new Error("Automatic snapshots must be handed directly to ChatHelp and not retained in extension storage.");
}
for (const [name, source] of [["background", background], ["extractor", extractor], ["sync content script", syncScript], ["app bridge", bridge]]) {
  for (const forbidden of [/\.click\s*\(/, /fetch\s*\(/, /XMLHttpRequest/, /chrome\.cookies/, /chrome\.webRequest/, /chrome\.debugger/]) {
    if (forbidden.test(source)) throw new Error(name + " contains forbidden LinkedIn automation, secret access, or network capability: " + forbidden);
  }
}
if (!bridge.includes("event.source !== window") || !bridge.includes("event.origin !== window.location.origin")) {
  throw new Error("The app bridge must validate both message source and origin.");
}

console.log("Chrome extension boundary verified: opt-in visible-conversation sync, local handoff, no cookie, network, inbox-scan, or send automation.");
