import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const background = await readFile("extension/background.js", "utf8");
const extractor = await readFile("extension/extractor.js", "utf8");
const bridge = await readFile("extension/app-bridge.js", "utf8");
const expectedPermissions = ["activeTab", "scripting", "storage"];

if (JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error(`Chrome permissions must remain exactly: ${expectedPermissions.join(", ")}`);
}
if ((manifest.host_permissions ?? []).some((permission) => /linkedin\.com/i.test(permission))) {
  throw new Error("LinkedIn must not be a persistent host permission; explicit activeTab access is required.");
}
if (!background.includes("chrome.action.onClicked") || !background.includes("chrome.scripting.executeScript")) {
  throw new Error("LinkedIn extraction must remain bound to the extension action click.");
}
if (!background.includes('importScripts("extractor.js")') || !background.includes("CHATHELP_LINKEDIN_EXTENSION_STATUS")) {
  throw new Error("Capture extraction and failures must be handed to ChatHelp through the auditable extension status bridge.");
}
if (!background.includes("CHATHELP_SET_SELECTED_LINKEDIN_CONTACT") || !background.includes("chrome.storage.session")) {
  throw new Error("The extension must remain locked to the contact selected in ChatHelp using session-only extension state.");
}
if (extractor.indexOf("identityMatches") < 0 || extractor.indexOf("identityMatches") > extractor.indexOf("const eventNodes")) {
  throw new Error("The extension must verify the selected contact before traversing visible message nodes.");
}
for (const [name, source] of [["background", background], ["extractor", extractor], ["app bridge", bridge]]) {
  for (const forbidden of [/\.click\s*\(/, /fetch\s*\(/, /XMLHttpRequest/, /chrome\.cookies/, /chrome\.webRequest/]) {
    if (forbidden.test(source)) throw new Error(`${name} contains forbidden automation or network capability: ${forbidden}`);
  }
}
if (!bridge.includes("event.source !== window") || !bridge.includes("event.origin !== window.location.origin")) {
  throw new Error("The app bridge must validate both message source and origin.");
}

console.log("Chrome extension boundary verified: explicit activeTab read, local handoff, no send or network automation.");
