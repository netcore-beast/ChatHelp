import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const APP_URL = "https://chathelp-private-cloud.project-mission-ai.workers.dev/";
const LINKEDIN_URL = "https://www.linkedin.com/messaging/thread/amit/";

function loadBackground(options: { granted?: boolean; extraction?: unknown } = {}) {
  const localData: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {};
  let granted = options.granted === true;
  let clickHandler: ((tab: { id?: number; url?: string }) => Promise<void>) | null = null;
  let runtimeListener: ((message: Record<string, unknown>, sender: Record<string, unknown>, sendResponse: (response: unknown) => void) => boolean) | null = null;
  const removedListeners: Array<(permissions: { origins?: string[] }) => void> = [];
  const registeredScripts: Array<Record<string, unknown>> = [];
  const sendToTab = vi.fn(async (...args: [number, unknown]) => { void args; });
  const extraction = options.extraction ?? { ok: false, error: { code: "messages_not_found", message: "No visible messages." } };
  const executeScript = vi.fn(async () => [{ result: extraction }]);
  const storageArea = (data: Record<string, unknown>) => ({
    get: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map((key) => [key, data[key]]));
    }),
    set: vi.fn(async (value: Record<string, unknown>) => Object.assign(data, value)),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
  });
  const requestPermission = vi.fn(async (request: { origins: string[] }) => {
    granted = request.origins[0] === "https://www.linkedin.com/*";
    return granted;
  });
  const removePermission = vi.fn(async () => {
    granted = false;
    return true;
  });
  const registerContentScripts = vi.fn(async (scripts: Array<Record<string, unknown>>) => {
    registeredScripts.splice(0, registeredScripts.length, ...scripts);
  });
  const unregisterContentScripts = vi.fn(async () => {
    registeredScripts.splice(0);
  });
  const context: Record<string, unknown> = {
    URL,
    crypto: webcrypto,
    setTimeout: vi.fn(),
    importScripts: vi.fn(() => {
      context.extractOpenLinkedInConversation = () => extraction;
    }),
  };
  context.chrome = {
    action: {
      onClicked: { addListener: (listener: typeof clickHandler) => { clickHandler = listener; } },
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    tabs: {
      query: vi.fn(async ({ url }: { url: string }) => url.startsWith(APP_URL)
        ? [{ id: 9, windowId: 2, url: APP_URL }]
        : [{ id: 7, windowId: 1, url: LINKEDIN_URL }]),
      update: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      sendMessage: sendToTab,
    },
    windows: { update: vi.fn(async () => undefined) },
    scripting: {
      executeScript,
      getRegisteredContentScripts: vi.fn(async () => registeredScripts),
      registerContentScripts,
      unregisterContentScripts,
    },
    storage: { local: storageArea(localData), session: storageArea(sessionData) },
    permissions: {
      contains: vi.fn(async () => granted),
      request: requestPermission,
      remove: removePermission,
      onRemoved: { addListener: (listener: (permissions: { origins?: string[] }) => void) => removedListeners.push(listener) },
    },
    runtime: {
      onMessage: { addListener: (listener: typeof runtimeListener) => { runtimeListener = listener; } },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
  };
  runInNewContext(readFileSync("extension/background.js", "utf8"), context, { filename: "extension/background.js" });

  const dispatch = (message: Record<string, unknown>, sender: Record<string, unknown>) => new Promise<unknown>((resolve) => {
    if (!runtimeListener) throw new Error("Expected runtime listener.");
    const asyncResponse = runtimeListener(message, sender, resolve);
    if (!asyncResponse) queueMicrotask(() => resolve(undefined));
  });
  return {
    clickHandler: () => clickHandler,
    dispatch,
    executeScript,
    localData,
    sessionData,
    requestPermission,
    removePermission,
    registerContentScripts,
    unregisterContentScripts,
    registeredScripts,
    sendToTab,
  };
}

describe("ChatHelp extension automatic sync coordinator", () => {
  it("requests only the optional LinkedIn origin and registers an isolated messaging script", async () => {
    const harness = loadBackground();
    const response = await harness.dispatch(
      { type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "enable" },
      { url: APP_URL + "settings" },
    ) as { ok: boolean };
    expect(response.ok).toBe(true);
    expect(harness.requestPermission).toHaveBeenCalledWith({ origins: ["https://www.linkedin.com/*"] });
    expect(harness.localData).toMatchObject({ linkedinAutoSyncEnabled: true, linkedinAutoSyncPaused: false });
    expect(harness.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({
      matches: ["https://www.linkedin.com/messaging/*"],
      world: "ISOLATED",
      js: ["extractor.js", "linkedin-sync.js"],
    })]);
    expect(harness.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["extractor.js", "linkedin-sync.js"],
      world: "ISOLATED",
    });
  });

  it("pausing prevents automatic snapshots from being handed to the app", async () => {
    const harness = loadBackground({ granted: true });
    await harness.dispatch({ type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "enable" }, { url: APP_URL });
    await harness.dispatch({ type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "pause" }, { url: APP_URL });
    harness.sendToTab.mockClear();
    await harness.dispatch({ type: "CHATHELP_AUTO_SYNC_SNAPSHOT", snapshot: { captureMode: "automatic" } }, { url: LINKEDIN_URL, tab: { url: LINKEDIN_URL } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.sendToTab.mock.calls.some(([, message]) => (message as { type?: string }).type === "CHATHELP_LINKEDIN_SNAPSHOT")).toBe(false);
  });

  it("disabling unregisters the content script and revokes LinkedIn permission", async () => {
    const harness = loadBackground({ granted: true });
    await harness.dispatch({ type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "enable" }, { url: APP_URL });
    await harness.dispatch({ type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "disable" }, { url: APP_URL });
    expect(harness.unregisterContentScripts).toHaveBeenCalled();
    expect(harness.removePermission).toHaveBeenCalledWith({ origins: ["https://www.linkedin.com/*"] });
    expect(harness.localData).toMatchObject({ linkedinAutoSyncEnabled: false, linkedinAutoSyncPaused: false });
  });

  it("hands automatic content directly to ChatHelp without storing it", async () => {
    const snapshot = {
      source: "chathelp-linkedin-extension",
      version: 2,
      captureMode: "automatic",
      captureId: "capture-auto",
      contact: { name: "Amit" },
      messages: [{ id: "one", body: "Hello" }],
    };
    const harness = loadBackground({ granted: true });
    await harness.dispatch({ type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "enable" }, { url: APP_URL });
    harness.sendToTab.mockClear();
    await harness.dispatch({ type: "CHATHELP_AUTO_SYNC_SNAPSHOT", snapshot }, { url: LINKEDIN_URL, tab: { url: LINKEDIN_URL } });
    await vi.waitFor(() => expect(harness.sendToTab).toHaveBeenCalledWith(9, { type: "CHATHELP_LINKEDIN_SNAPSHOT", snapshot }));
    expect(Object.values(harness.localData)).not.toContain(snapshot);
    expect(Object.values(harness.sessionData)).not.toContain(snapshot);
  });

  it("keeps the one-time action capture as an ephemeral acknowledged fallback", async () => {
    const snapshot = {
      source: "chathelp-linkedin-extension",
      version: 2,
      captureMode: "manual",
      captureId: "capture-manual",
      capturedAt: "2026-08-02T12:00:00.000Z",
      pageUrl: LINKEDIN_URL,
      contact: { name: "Amit", profileUrl: "", headline: "", company: "", avatarUrl: "" },
      messages: [{ id: "one", sourceId: "one", role: "them", speaker: "Amit", body: "Hello", createdAt: "", attachments: [] }],
    };
    const harness = loadBackground({ extraction: { ok: true, snapshot } });
    const click = harness.clickHandler();
    if (!click) throw new Error("Expected extension click handler.");
    await click({ id: 7, url: LINKEDIN_URL });
    expect(harness.sessionData.pendingManualLinkedInSnapshot).toEqual(snapshot);
    expect(harness.localData).not.toHaveProperty("pendingManualLinkedInSnapshot");
    expect(harness.sendToTab).toHaveBeenCalledWith(9, { type: "CHATHELP_LINKEDIN_SNAPSHOT", snapshot });
  });
});
