// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { resetVaultForTests } from "../src/lib/secureVault";

vi.mock("@/lib/localOcr", () => ({
  captureVisibleScreen: vi.fn(),
  cropImageToRegion: vi.fn(),
  extractTextFromImage: vi.fn(),
}));

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

describe("ChatHelp extension handshake", () => {
  beforeEach(async () => {
    await resetVaultForTests();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
  });

  it("requests pending capture once without a READY/REQUEST feedback loop", async () => {
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === "CHATHELP_GET_PENDING_CAPTURE"
      ? { snapshot: null, status: null }
      : { ok: true });
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          getManifest: () => ({ version: "0.5.1" }),
          sendMessage,
          onMessage: { addListener: vi.fn() },
        },
      },
    });

    let snapshotRequests = 0;
    vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
      const message = data as { source?: string; type?: string };
      if (message.source === "chathelp-app" && message.type === "CHATHELP_REQUEST_LINKEDIN_SNAPSHOT") {
        snapshotRequests += 1;
        if (snapshotRequests > 5) return;
      }
      queueMicrotask(() => window.dispatchEvent(new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data,
      })));
    });

    runInThisContext(readFileSync("extension/app-bridge.js", "utf8"), { filename: "extension/app-bridge.js" });
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "CHATHELP_GET_PENDING_CAPTURE" }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(snapshotRequests).toBe(1);
    expect(sendMessage.mock.calls.filter(([message]) => message.type === "CHATHELP_GET_PENDING_CAPTURE")).toHaveLength(1);
  });
});
