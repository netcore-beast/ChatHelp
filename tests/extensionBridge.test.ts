// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("ChatHelp extension app bridge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
  });

  it("announces its version and delivers pending captures plus automatic sync state", async () => {
    const snapshot = { source: "chathelp-linkedin-extension", captureId: "capture-1" };
    const status = { source: "chathelp-linkedin-extension", statusId: "status-1" };
    const state = { source: "chathelp-linkedin-extension", version: 1, stateId: "state-1", enabled: false };
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "CHATHELP_GET_PENDING_CAPTURE"
      ? { snapshot, status }
      : message.type === "CHATHELP_GET_SYNC_STATE" ? state : { ok: true, state });
    const runtimeListeners: Array<(message: unknown) => void> = [];
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          getManifest: () => ({ version: "0.4.2" }),
          sendMessage,
          onMessage: { addListener: (listener: (message: unknown) => void) => runtimeListeners.push(listener) },
        },
      },
    });

    const posted: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
      posted.push(data);
    });
    runInThisContext(readFileSync("extension/app-bridge.js", "utf8"), { filename: "extension/app-bridge.js" });
    expect(posted).toContainEqual({ source: "chathelp-linkedin-extension", type: "CHATHELP_EXTENSION_READY", version: "0.4.2" });

    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: { source: "chathelp-app", type: "CHATHELP_REQUEST_LINKEDIN_SNAPSHOT" },
    }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "CHATHELP_GET_PENDING_CAPTURE" }));
    expect(sendMessage).toHaveBeenCalledWith({ type: "CHATHELP_GET_SYNC_STATE" });
    expect(posted).toContainEqual({ source: "chathelp-linkedin-extension", type: "CHATHELP_LINKEDIN_EXTENSION_STATUS", payload: status });
    expect(posted).toContainEqual({ source: "chathelp-linkedin-extension", type: "CHATHELP_LINKEDIN_SNAPSHOT", payload: snapshot });
    expect(posted).toContainEqual({ source: "chathelp-linkedin-extension", type: "CHATHELP_LINKEDIN_SYNC_STATE", payload: state });

    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: { source: "chathelp-app", type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "enable" },
    }));
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "CHATHELP_LINKEDIN_SYNC_COMMAND", command: "enable" }));

    runtimeListeners[0]?.({ type: "CHATHELP_LINKEDIN_EXTENSION_STATUS", status });
    expect(posted.filter((item) => (item as { type?: string }).type === "CHATHELP_LINKEDIN_EXTENSION_STATUS")).toHaveLength(2);
  });
});
