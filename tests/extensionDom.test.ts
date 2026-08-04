// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ExtractionResult {
  ok: boolean;
  error?: { code: string; message: string; observedContact: { name: string; profileUrl: string } | null };
  snapshot?: {
    captureMode: "automatic" | "manual";
    contact: { name: string; profileUrl: string; company: string };
    messages: Array<{ id: string; sourceId: string; role: "me" | "them"; body: string }>;
  };
}

type Extractor = (captureMode?: "automatic" | "manual") => ExtractionResult;
const extractor = () => (globalThis as typeof globalThis & { extractOpenLinkedInConversation: Extractor }).extractOpenLinkedInConversation;

beforeAll(() => {
  runInThisContext(readFileSync("extension/extractor.js", "utf8"), { filename: "extension/extractor.js" });
});

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(Element.prototype, "getClientRects", { configurable: true, value: () => [{ width: 100, height: 20 }] });
  window.history.replaceState({}, "", "/messaging/thread/amit-dabral/?trk=remove");
});

describe("LinkedIn visible central conversation extraction", () => {
  it("reads the visible header first and captures modern message markup", () => {
    document.body.innerHTML = [
      '<main>',
      '<header data-view-name="message-thread-header">',
      '<a href="https://www.linkedin.com/in/amit-dabral/?trk=message" aria-label="View Amit Dabral profile"><span data-anonymize="person-name">Amit Dabral</span></a>',
      '<div data-view-name="message-thread-subtitle">Founder at Example Co</div>',
      '</header>',
      '<section data-view-name="message-thread-list">',
      '<div data-view-name="message-event" data-event-urn="urn:li:msg:1"><span data-view-name="message-sender">Amit Dabral</span><div data-view-name="message-bubble">Thanks for connecting.</div><time datetime="2026-08-02T12:00:00.000Z"></time></div>',
      '<div data-view-name="message-event" data-event-urn="urn:li:msg:2" data-sender-is-viewer="true"><span data-view-name="message-sender">You</span><div data-view-name="message-bubble">Glad to connect, Amit.</div></div>',
      '</section>',
      '</main>',
    ].join("");

    const result = extractor()("automatic");
    expect(result.ok).toBe(true);
    expect(result.snapshot).toMatchObject({
      captureMode: "automatic",
      contact: { name: "Amit Dabral", profileUrl: "https://www.linkedin.com/in/amit-dabral/", company: "Example Co" },
    });
    expect(result.snapshot?.messages).toEqual([
      expect.objectContaining({ sourceId: "urn:li:msg:1", role: "them", body: "Thanks for connecting." }),
      expect.objectContaining({ sourceId: "urn:li:msg:2", role: "me", body: "Glad to connect, Amit." }),
    ]);
  });

  it("excludes background conversation-list previews and side panels", () => {
    document.body.innerHTML = [
      '<aside aria-label="Conversation list"><header data-view-name="message-thread-header"><a href="/in/wrong-person/"><span data-anonymize="person-name">Wrong Person</span></a></header><section data-view-name="message-thread-list"><div data-view-name="message-event"><div data-view-name="message-bubble">Private preview must be excluded.</div></div></section></aside>',
      '<main>',
      '<header data-view-name="message-thread-header"><a href="/in/mathieu-henry/"><span data-anonymize="person-name">Mathieu Henry</span></a></header>',
      '<section data-view-name="message-thread-list"><div data-view-name="message-event" data-event-urn="central-1"><span data-view-name="message-sender">Mathieu Henry</span><div data-view-name="message-bubble">Visible central message.</div></div></section>',
      '<aside><div data-view-name="message-event"><div data-view-name="message-bubble">Recommendation text.</div></div></aside>',
      '</main>',
    ].join("");
    const result = extractor()();
    expect(result.snapshot?.messages.map((message) => message.body)).toEqual(["Visible central message."]);
  });

  it("does not treat regenerated ordinary DOM IDs as stable message identifiers", () => {
    const renderConversation = (domId: string) => {
      document.body.innerHTML = [
        '<main>',
        '<header data-view-name="message-thread-header"><a href="/in/amit-dabral/"><span data-anonymize="person-name">Amit Dabral</span></a></header>',
        '<section data-view-name="message-thread-list">',
        `<div id="${domId}" data-view-name="message-event"><span data-view-name="message-sender">Amit Dabral</span><div data-view-name="message-bubble">That would be great</div></div>`,
        '</section>',
        '</main>',
      ].join("");
      return extractor()().snapshot?.messages[0];
    };

    const first = renderConversation("ember-transient-101");
    const second = renderConversation("ember-transient-947");
    expect(first?.sourceId).toBe("");
    expect(second?.sourceId).toBe("");
    expect(second?.id).toBe(first?.id);
  });

  it("does not traverse message nodes when the visible header is unsupported", () => {
    document.body.innerHTML = '<main><section class="msg-s-message-list-container"><div class="msg-s-message-list__event"><p>Message body must not be read.</p></div></section></main>';
    const thread = document.querySelector(".msg-s-message-list-container") as Element;
    const traversal = vi.spyOn(thread, "querySelectorAll");
    const result = extractor()();
    expect(result).toMatchObject({ ok: false, error: { code: "contact_header_not_found" } });
    expect(traversal).not.toHaveBeenCalled();
  });

  it("reports no conversation and unsupported empty-message states safely", () => {
    expect(extractor()()).toMatchObject({ ok: false, error: { code: "conversation_not_found" } });
    document.body.innerHTML = '<main><header class="msg-thread__top-card"><a class="msg-thread__link-to-profile" href="/in/mathieu-henry/">Mathieu Henry</a></header><section class="msg-s-message-list-container"><div>Nothing visible</div></section></main>';
    expect(extractor()()).toMatchObject({ ok: false, error: { code: "messages_not_found" } });
  });
});
