// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (message: { type?: string; state?: { enabled?: boolean; paused?: boolean; permissionGranted?: boolean } }) => void;

describe("LinkedIn isolated automatic-sync observer", () => {
  let runtimeListeners: RuntimeListener[];
  let sendMessage: ReturnType<typeof vi.fn>;
  let extractionCount: number;
  let currentContact: string;

  beforeEach(() => {
    vi.useFakeTimers();
    runtimeListeners = [];
    extractionCount = 0;
    currentContact = "Taylor Lee";
    history.replaceState({}, "", "/messaging/thread/taylor-lee/");
    document.body.innerHTML = '<main><section data-view-name="message-thread-list"></section></main>';
    sendMessage = vi.fn(async (message: { type?: string }) => {
      if (message.type === "CHATHELP_GET_SYNC_STATE") {
        return { enabled: true, paused: false, permissionGranted: true };
      }
      return { ok: true };
    });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          sendMessage,
          onMessage: { addListener: (listener: RuntimeListener) => runtimeListeners.push(listener) },
        },
      },
    });
    Object.defineProperty(globalThis, "extractOpenLinkedInConversation", {
      configurable: true,
      value: vi.fn(() => {
        extractionCount += 1;
        const slug = currentContact.toLowerCase().replaceAll(" ", "-");
        return {
          ok: true,
          snapshot: {
            source: "chathelp-linkedin-extension",
            version: 2,
            captureMode: "automatic",
            captureId: `capture-${extractionCount}`,
            capturedAt: "2026-08-03T12:00:00.000Z",
            pageUrl: `https://www.linkedin.com/messaging/thread/${slug}/`,
            contact: { name: currentContact, profileUrl: `https://www.linkedin.com/in/${slug}/` },
            messages: [{ sourceId: `${slug}-one`, id: `${slug}-one`, role: "them", speaker: currentContact, body: `Hello from ${currentContact}`, createdAt: "2026-08-03T11:59:00.000Z", attachments: [] }],
          },
        };
      }),
    });
    Reflect.deleteProperty(globalThis, "__chathelpLinkedInSyncV1");
  });

  afterEach(() => {
    runtimeListeners.forEach((listener) => listener({ type: "CHATHELP_LINKEDIN_SYNC_STATE_CHANGED", state: { enabled: false, paused: false, permissionGranted: false } }));
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "chrome");
    Reflect.deleteProperty(globalThis, "extractOpenLinkedInConversation");
    Reflect.deleteProperty(globalThis, "__chathelpLinkedInSyncV1");
  });

  it("debounces repeated DOM mutations and never duplicates an unchanged snapshot", async () => {
    runInThisContext(readFileSync("extension/linkedin-sync.js", "utf8"), { filename: "extension/linkedin-sync.js" });
    document.body.append(document.createElement("div"), document.createElement("div"), document.createElement("div"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(extractionCount).toBe(1);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === "CHATHELP_AUTO_SYNC_SNAPSHOT")).toHaveLength(1);

    document.body.append(document.createElement("span"), document.createElement("span"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(extractionCount).toBe(2);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === "CHATHELP_AUTO_SYNC_SNAPSHOT")).toHaveLength(1);
  });

  it("synchronizes a newly opened conversation after LinkedIn SPA route and DOM changes", async () => {
    runInThisContext(readFileSync("extension/linkedin-sync.js", "utf8"), { filename: "extension/linkedin-sync.js" });
    await vi.advanceTimersByTimeAsync(1_000);
    currentContact = "Mathieu Henry";
    history.pushState({}, "", "/messaging/thread/mathieu-henry/");
    document.body.append(document.createElement("article"));
    await vi.advanceTimersByTimeAsync(1_500);
    const snapshots = sendMessage.mock.calls
      .filter(([message]) => message.type === "CHATHELP_AUTO_SYNC_SNAPSHOT")
      .map(([message]) => message.snapshot.contact.name);
    expect(snapshots).toEqual(["Taylor Lee", "Mathieu Henry"]);
  });

  it("does not read while paused and permanently stops after disabling or permission removal", async () => {
    let paused = false;
    sendMessage.mockImplementation(async (message: { type?: string }) => message.type === "CHATHELP_GET_SYNC_STATE"
      ? { enabled: true, paused, permissionGranted: true }
      : { ok: true });
    runInThisContext(readFileSync("extension/linkedin-sync.js", "utf8"), { filename: "extension/linkedin-sync.js" });
    paused = true;
    runtimeListeners[0]?.({ type: "CHATHELP_LINKEDIN_SYNC_STATE_CHANGED", state: { enabled: true, paused: true, permissionGranted: true } });
    document.body.append(document.createElement("div"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(extractionCount).toBe(0);

    runtimeListeners[0]?.({ type: "CHATHELP_LINKEDIN_SYNC_STATE_CHANGED", state: { enabled: false, paused: false, permissionGranted: false } });
    paused = false;
    document.body.append(document.createElement("div"));
    history.pushState({}, "", "/messaging/thread/stopped/");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(extractionCount).toBe(0);
  });
});
