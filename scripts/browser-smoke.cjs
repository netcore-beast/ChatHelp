/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const { mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.commandLine.appendSwitch("disable-setuid-sandbox");
app.commandLine.appendSwitch("no-sandbox");
const profile = join(tmpdir(), `chathelp-smoke-${process.pid}`);
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);

const target = process.env.CHATHELP_VERIFY_URL ?? "http://127.0.0.1:3000/";
const timeout = setTimeout(() => {
  console.error("Browser smoke test timed out.");
  app.exit(1);
}, 30_000);

app.whenReady().then(async () => {
  const errors = [];
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false },
  });
  window.webContents.on("console-message", (_event, details) => {
    const message = typeof details?.message === "string" ? details.message : String(details ?? "");
    if (/Content Security Policy|Uncaught|ReferenceError|TypeError/i.test(message)) errors.push(message);
  });
  window.webContents.on("did-fail-load", (_event, code, description) => errors.push(`Load failed ${code}: ${description}`));

  try {
    await window.loadURL(target);
    let state;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      state = await window.webContents.executeJavaScript(`({
        title: document.title,
        heading: document.querySelector("h1")?.textContent ?? "",
        checking: document.body.textContent?.includes("Checking this browser for an encrypted workspace") ?? false,
        indexedDb: typeof indexedDB !== "undefined",
        bodyText: document.body.innerText.slice(0, 800)
      })`);
      if (state.heading || errors.length) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (errors.length) throw new Error(errors.join("\n"));
    if (!state?.indexedDb) throw new Error("IndexedDB is unavailable in the rendered app.");
    if (state.checking) throw new Error(`The application remained on its startup loading screen. Body: ${state.bodyText}`);
    if (state.heading !== "Your conversations stay under your key.") throw new Error(`Unexpected startup heading: ${state?.heading || "none"}`);
    console.log("Browser smoke verified: React hydrated and secure storage initialization completed.");
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    clearTimeout(timeout);
    app.exit(1);
  }
});
