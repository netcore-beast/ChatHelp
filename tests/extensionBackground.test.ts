import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function loadBackground(extraction: unknown) {
  const localData: Record<string, unknown> = {};
  const sessionData: Record<string, unknown> = {
    selectedLinkedInContact: { contactId: "contact-amit", name: "Amit", profileUrl: "" },
  };
  let clickHandler: ((tab: { id?: number; url?: string }) => Promise<void>) | null = null;
  const sendToApp = vi.fn(async () => undefined);
  const executeScript = vi.fn(async () => [{ result: extraction }]);
  const context: Record<string, unknown> = {
    URL,
    crypto: webcrypto,
    setTimeout: vi.fn(),
  };
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
  context.importScripts = vi.fn(() => {
    context.extractOpenLinkedInConversation = () => extraction;
  });
  context.chrome = {
    action: {
      onClicked: { addListener: (listener: typeof clickHandler) => { clickHandler = listener; } },
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 9, windowId: 2 }]),
      update: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      sendMessage: sendToApp,
    },
    windows: { update: vi.fn(async () => undefined) },
    scripting: { executeScript },
    storage: { local: storageArea(localData), session: storageArea(sessionData) },
    runtime: { onMessage: { addListener: vi.fn() } },
  };
  runInNewContext(readFileSync("extension/background.js", "utf8"), context, { filename: "extension/background.js" });
  return { clickHandler: () => clickHandler, executeScript, localData, sendToApp };
}

describe("ChatHelp extension background handoff", () => {
  it("persists and sends a contact mismatch reason without a message snapshot", async () => {
    const extraction = {
      ok: false,
      error: {
        code: "contact_mismatch",
        message: "ChatHelp is locked to Amit, but the open conversation is Amit Dabral.",
        observedContact: { name: "Amit Dabral", profileUrl: "https://www.linkedin.com/in/amit-dabral/" },
      },
    };
    const harness = loadBackground(extraction);
    const click = harness.clickHandler();
    if (!click) throw new Error("Expected extension click handler.");
    await click({ id: 7, url: "https://www.linkedin.com/messaging/thread/amit/" });

    expect(harness.executeScript).toHaveBeenCalledOnce();
    expect(harness.localData.pendingLinkedInSnapshot).toBeUndefined();
    expect(harness.localData.pendingLinkedInCaptureStatus).toMatchObject({
      kind: "error",
      code: "contact_mismatch",
      observedContact: { name: "Amit Dabral" },
    });
    expect(harness.sendToApp).toHaveBeenCalledWith(9, expect.objectContaining({
      type: "CHATHELP_LINKEDIN_EXTENSION_STATUS",
      status: expect.objectContaining({ code: "contact_mismatch" }),
    }));
  });

  it("stores and hands off only the explicit successful snapshot", async () => {
    const snapshot = {
      source: "chathelp-linkedin-extension",
      version: 1,
      captureId: "capture-1",
      capturedAt: "2026-08-02T12:00:00.000Z",
      contact: { name: "Amit", profileUrl: "", headline: "", avatarUrl: "" },
      pageUrl: "https://www.linkedin.com/messaging/thread/amit/",
      messages: [{ id: "one", role: "them", speaker: "Amit", body: "Hello", createdAt: "", attachments: [] }],
    };
    const harness = loadBackground({ ok: true, snapshot });
    const click = harness.clickHandler();
    if (!click) throw new Error("Expected extension click handler.");
    await click({ id: 7, url: "https://www.linkedin.com/messaging/thread/amit/" });

    expect(harness.localData.pendingLinkedInSnapshot).toEqual(snapshot);
    expect(harness.sendToApp).toHaveBeenCalledWith(9, { type: "CHATHELP_LINKEDIN_SNAPSHOT", snapshot });
  });
});
