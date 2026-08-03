// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ExtractionResult {
  ok: boolean;
  error?: { code: string; message: string; observedContact: { name: string; profileUrl: string } | null };
  snapshot?: {
    contact: { name: string; profileUrl: string };
    messages: Array<{ role: "me" | "them"; body: string }>;
  };
}

type Extractor = (contact: { name: string; profileUrl: string }) => ExtractionResult;

function extractor(): Extractor {
  return (globalThis as typeof globalThis & { extractOpenLinkedInConversation: Extractor }).extractOpenLinkedInConversation;
}

beforeAll(() => {
  runInThisContext(readFileSync("extension/extractor.js", "utf8"), { filename: "extension/extractor.js" });
});

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(Element.prototype, "getClientRects", {
    configurable: true,
    value: () => [{ width: 100, height: 20 }],
  });
  window.history.replaceState({}, "", "/messaging/thread/amit-dabral/?trk=remove");
});

describe("LinkedIn visible conversation DOM extraction", () => {
  it("captures modern visible message markup after a canonical profile match", () => {
    document.body.innerHTML = `
      <header data-view-name="message-thread-header">
        <a href="https://www.linkedin.com/in/amit-dabral/?trk=message" aria-label="View Amit Dabral's profile">
          <span data-anonymize="person-name">Amit Dabral</span>
        </a>
        <div data-view-name="message-thread-subtitle">Founder at Example Co</div>
      </header>
      <section data-view-name="message-thread-list">
        <div data-view-name="message-event" data-event-urn="urn:li:msg:1">
          <span data-view-name="message-sender">Amit Dabral</span>
          <div data-view-name="message-bubble">Thanks for connecting.</div>
          <time datetime="2026-08-02T12:00:00.000Z"></time>
        </div>
        <div data-view-name="message-event" data-event-urn="urn:li:msg:2" data-sender-is-viewer="true">
          <span data-view-name="message-sender">You</span>
          <div data-view-name="message-bubble">Glad to connect, Amit.</div>
          <time datetime="2026-08-02T12:01:00.000Z"></time>
        </div>
      </section>`;

    const result = extractor()({ name: "Amit Dabral", profileUrl: "https://linkedin.com/in/amit-dabral" });
    expect(result.ok).toBe(true);
    expect(result.snapshot?.contact).toMatchObject({ name: "Amit Dabral", profileUrl: "https://www.linkedin.com/in/amit-dabral/" });
    expect(result.snapshot?.messages).toEqual([
      expect.objectContaining({ role: "them", body: "Thanks for connecting." }),
      expect.objectContaining({ role: "me", body: "Glad to connect, Amit." }),
    ]);
  });

  it("returns only the observed identity and does not traverse messages on a mismatch", () => {
    document.body.innerHTML = `
      <header class="msg-thread__top-card">
        <a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/amit-dabral/">Amit Dabral · 1st degree connection</a>
      </header>
      <section class="msg-s-message-list-container">
        <div class="msg-s-message-list__event"><p>Private message text must not be read.</p></div>
      </section>`;
    const thread = document.querySelector(".msg-s-message-list-container") as Element;
    const messageTraversal = vi.spyOn(thread, "querySelectorAll");

    const result = extractor()({ name: "Mathieu Henry", profileUrl: "" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "contact_mismatch",
        observedContact: { name: "Amit Dabral", profileUrl: "https://www.linkedin.com/in/amit-dabral/" },
      },
    });
    expect(messageTraversal).not.toHaveBeenCalled();
  });

  it("explains when the matched conversation has no visible message nodes", () => {
    document.body.innerHTML = `
      <header class="msg-thread__top-card"><a class="msg-thread__link-to-profile" href="https://www.linkedin.com/in/mathieu-henry/">Mathieu Henry</a></header>
      <section class="msg-s-message-list-container"><div>Scroll to the conversation</div></section>`;
    const result = extractor()({ name: "Mathieu Henry", profileUrl: "https://www.linkedin.com/in/mathieu-henry/" });
    expect(result).toMatchObject({ ok: false, error: { code: "messages_not_found" } });
  });
});
