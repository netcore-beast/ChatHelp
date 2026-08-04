// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import {
  LINKEDIN_EXTENSION_SOURCE,
  LINKEDIN_SNAPSHOT_EVENT,
  LINKEDIN_SYNC_STATE_EVENT,
} from "../src/lib/linkedinExtension";
import { resetVaultForTests } from "../src/lib/secureVault";

vi.mock("@/lib/localOcr", () => ({
  captureVisibleScreen: vi.fn().mockResolvedValue(new Blob(["screen"])),
  cropImageToRegion: vi.fn().mockImplementation(async (image: Blob) => image),
  extractTextFromImage: vi.fn().mockResolvedValue("Alex\nThanks for connecting."),
}));

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
const desktopUserAgent = navigator.userAgent;

type SnapshotMessage = {
  id: string;
  sourceId: string;
  role: "me" | "them";
  speaker: string;
  body: string;
  createdAt: string;
  attachments: never[];
};

const automaticSnapshot = (messages: SnapshotMessage[] = [{
  id: "urn:li:msg:1",
  sourceId: "urn:li:msg:1",
  role: "them" as const,
  speaker: "Taylor Lee",
  body: "Could you share the role brief?",
  createdAt: "2026-08-02T11:59:00.000Z",
  attachments: [],
}]) => ({
  source: LINKEDIN_EXTENSION_SOURCE,
  version: 2 as const,
  captureMode: "automatic" as const,
  captureId: "capture-ui-1",
  capturedAt: "2026-08-02T12:00:00.000Z",
  pageUrl: "https://www.linkedin.com/messaging/thread/taylor-lee/",
  contact: {
    name: "Taylor Lee",
    headline: "Talent Partner",
    company: "Example Co",
    profileUrl: "https://www.linkedin.com/in/taylor-lee/",
    avatarUrl: "",
  },
  messages,
});

function announceExtension() {
  window.dispatchEvent(new MessageEvent("message", {
    source: window,
    origin: window.location.origin,
    data: { source: LINKEDIN_EXTENSION_SOURCE, type: "CHATHELP_EXTENSION_READY", version: "0.4.1" },
  }));
  window.dispatchEvent(new MessageEvent("message", {
    source: window,
    origin: window.location.origin,
    data: {
      source: LINKEDIN_EXTENSION_SOURCE,
      type: LINKEDIN_SYNC_STATE_EVENT,
      payload: {
        source: LINKEDIN_EXTENSION_SOURCE,
        version: 1,
        stateId: "state-ui-1",
        occurredAt: "2026-08-02T12:00:00.000Z",
        enabled: true,
        paused: false,
        permissionGranted: true,
        code: "waiting_for_conversation",
        message: "Waiting for a LinkedIn conversation.",
        lastContactName: "",
        lastMessageCount: 0,
      },
    },
  }));
}

function deliverSnapshot(snapshot = automaticSnapshot()) {
  window.dispatchEvent(new MessageEvent("message", {
    source: window,
    origin: window.location.origin,
    data: { source: LINKEDIN_EXTENSION_SOURCE, type: LINKEDIN_SNAPSHOT_EVENT, payload: snapshot },
  }));
}

beforeEach(async () => {
  await resetVaultForTests();
  localStorage.clear();
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia: vi.fn() }, configurable: true });
  URL.createObjectURL = vi.fn(() => "blob:local-screen-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "userAgent", { value: desktopUserAgent, configurable: true });
});

describe("secure conversation workspace interaction", () => {
  it("creates and reopens a manual contact in the encrypted local vault", async () => {
    const user = userEvent.setup();
    const firstRender = render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Workspace navigation" })).toBeTruthy();
    expect(screen.getByLabelText("Conversation inbox")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.type(screen.getByLabelText("New contact name"), "Alex Morgan");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    expect(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /Alex Morgan/ })).toBeTruthy();
    expect(screen.getByLabelText("Conversation with Alex Morgan")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".save-state")?.textContent).toContain("Encrypted"), { timeout: 3000 });

    firstRender.unmount();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    expect(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /Alex Morgan/ })).toBeTruthy();
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
  }, 20_000);

  it("automatically creates an unknown contact and updates repeated snapshots without duplication", async () => {
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    announceExtension();
    deliverSnapshot();

    const conversation = await screen.findByLabelText("Conversation with Taylor Lee");
    expect(within(conversation).getAllByText("Could you share the role brief?")).toHaveLength(1);
    expect(screen.getByText("Opened LinkedIn conversation")).toBeTruthy();
    expect(screen.getByText(/Contact automatically added/i)).toBeTruthy();

    const secondMessage = {
      id: "urn:li:msg:2",
      sourceId: "urn:li:msg:2",
      role: "me" as const,
      speaker: "You",
      body: "Absolutely—I will send it here.",
      createdAt: "2026-08-02T12:01:00.000Z",
      attachments: [],
    };
    deliverSnapshot({ ...automaticSnapshot([...automaticSnapshot().messages, secondMessage]), captureId: "capture-ui-2" });
    deliverSnapshot({ ...automaticSnapshot([...automaticSnapshot().messages, secondMessage]), captureId: "capture-ui-3" });
    await waitFor(() => expect(within(screen.getByLabelText("Conversation with Taylor Lee")).getAllByText("Absolutely—I will send it here.")).toHaveLength(1));
    expect(within(screen.getByRole("navigation", { name: "Conversations" })).getAllByRole("button", { name: /Taylor Lee/ })).toHaveLength(1);
    expect(screen.getByText(/Existing contact updated|No new messages/i)).toBeTruthy();
  });

  it("generates exactly three editable drafts for a newly synchronized contact", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      drafts: ["I can share the brief here.", "Happy to send the details—what would be most useful?", "I’ll send a concise overview for you to review."],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    announceExtension();
    deliverSnapshot();
    expect(await screen.findByLabelText("Conversation with Taylor Lee")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.type(screen.getByLabelText(/Cloud access code/), "not-a-secret-test-placeholder");
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /Taylor Lee/ }));
    await user.type(screen.getByLabelText("What should your reply accomplish?"), "Answer Taylor and keep the exchange moving.");
    await user.click(screen.getByRole("button", { name: "Generate 3 drafts for Taylor Lee" }));

    expect(await screen.findByLabelText("Edit draft 1")).toBeTruthy();
    expect(screen.getByLabelText("Edit draft 2")).toBeTruthy();
    expect(screen.getByLabelText("Edit draft 3")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.credentials).toBe("same-origin");
    expect(screen.getByRole("link", { name: /Open LinkedIn to review and paste/ })).toBeTruthy();
  }, 20_000);

  it("keeps the Cloudflare Access session and shows its safe inline HTML-response error", async () => {
    const request = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Sign in</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    announceExtension();
    deliverSnapshot();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.type(screen.getByLabelText(/Cloud access code/), "not-a-secret-test-placeholder");
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: /Taylor Lee/ }));
    await user.type(screen.getByLabelText("What should your reply accomplish?"), "Write a short reply.");
    await user.click(screen.getByRole("button", { name: "Generate 3 drafts for Taylor Lee" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Drafts were not generated.*Cloudflare sign-in session could not be verified/);
    expect(request.mock.calls[0][1]?.credentials).toBe("same-origin");
  }, 20_000);

  it("marks automatic LinkedIn synchronization as desktop-only on mobile", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 16; Mobile)", configurable: true });
    Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    expect(await screen.findByText(/Automatic LinkedIn sync is desktop-only/)).toBeTruthy();
    expect(screen.getByText(/Manual paste and import remain available/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enable automatic LinkedIn conversation sync" })).toBeNull();
  });
});
