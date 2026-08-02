import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const background = await readFile("extension/background.js", "utf8");
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
for (const [name, source] of [["background", background], ["app bridge", bridge]]) {
  for (const forbidden of [/\.click\s*\(/, /fetch\s*\(/, /XMLHttpRequest/, /chrome\.cookies/, /chrome\.webRequest/]) {
    if (forbidden.test(source)) throw new Error(`${name} contains forbidden automation or network capability: ${forbidden}`);
  }
}
if (!bridge.includes("event.source !== window") || !bridge.includes("event.origin !== window.location.origin")) {
  throw new Error("The app bridge must validate both message source and origin.");
}

console.log("Chrome extension boundary verified: explicit activeTab read, local handoff, no send or network automation.");
