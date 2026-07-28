/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, desktopCapturer, dialog, net, protocol, session, shell } = require("electron");
const path = require("node:path");
const { existsSync } = require("node:fs");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([{ scheme: "chathelp", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const EXTERNAL_HOSTS = new Set(["linkedin.com", "www.linkedin.com", "mail.google.com", "outlook.office.com", "outlook.live.com"]);
const isTrustedAppUrl = (value) => value.startsWith("chathelp://app/");
const isApprovedExternal = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && EXTERNAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, "out") : path.join(app.getAppPath(), "out");
}

function resolveAppFile(requestUrl) {
  const url = new URL(requestUrl);
  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  relative = path.normalize(relative);
  const root = path.resolve(appRoot());
  let candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  if (!existsSync(candidate) && !path.extname(candidate)) candidate = path.join(root, relative, "index.html");
  if (!existsSync(candidate)) return null;
  return candidate;
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: "#f6f4ed",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      spellcheck: true,
      devTools: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isApprovedExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  await window.loadURL("chathelp://app/index.html");
}

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(session.defaultSession.getUserAgent() + " ChatHelpDesktop/0.1.0");
  protocol.handle("chathelp", (request) => {
    const file = resolveAppFile(request.url);
    return file ? net.fetch(pathToFileURL(file).toString()) : new Response("Not found", { status: 404 });
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "display-capture" && isTrustedAppUrl(webContents.getURL()));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!request.frame || !isTrustedAppUrl(request.frame.url) || !request.userGesture || !request.videoRequested) return callback({});
    const sources = (await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })).slice(0, 20);
    if (!sources.length) return callback({});
    const buttons = sources.map((source) => source.name.slice(0, 80));
    buttons.push("Cancel");
    const choice = await dialog.showMessageBox({ type: "question", title: "Choose what ChatHelp may read", message: "Select one screen or window. ChatHelp processes the captured image locally.", buttons, cancelId: buttons.length - 1, defaultId: buttons.length - 1, noLink: true });
    callback(choice.response < sources.length ? { video: sources[choice.response] } : {});
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
