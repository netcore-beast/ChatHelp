// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { createRecoveryBundle, importRecoveryKey } from "../src/lib/cloudRecovery";
import {
  LINKEDIN_EXTENSION_SOURCE,
  LINKEDIN_SNAPSHOT_EVENT,
  LINKEDIN_SYNC_COMMAND_EVENT,
  LINKEDIN_SYNC_STATE_EVENT,
} from "../src/lib/linkedinExtension";
import { createDeviceVault, openDeviceVault, resetVaultForTests, saveCloudRecoveryKey } from "../src/lib/secureVault";
import { createEmptyWorkspace } from "../src/lib/workspaceTypes";

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

function usageResponse(): Response {
  const totals = {
    uncachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, promptTokens: 0, completionTokens: 0,
    totalTokens: 0, estimatedNeurons: 0,
  };
  return new Response(JSON.stringify({
    periodStart: "2026-08-01T00:00:00.000Z",
    nextResetAt: "2026-09-01T00:00:00.000Z",
    providers: {
      anthropic: { provider: "anthropic", consumedMicroUsd: 0, allowanceMicroUsd: 10_000_000, remainingMicroUsd: 10_000_000, quality: "unavailable", totals, models: [] },
      workersAi: { provider: "workers_ai", consumedMicroUsd: 0, allowanceMicroUsd: 2_000_000, remainingMicroUsd: 2_000_000, quality: "unavailable", totals, models: [] },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function learningStatusResponse(overrides: Partial<{
  enabled: boolean;
  noticeVersion: string;
  retentionDays: number;
  counts: { classifier: number; evaluation: number; generative: number };
}> = {}): Response {
  return new Response(JSON.stringify({
    enabled: true,
    noticeVersion: "2026-08-09-v1",
    retentionDays: 365,
    counts: { classifier: 0, evaluation: 0, generative: 0 },
    ...overrides,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function learningRecordsResponse(records: readonly unknown[] = [], nextCursor: string | null = null): Response {
  return new Response(JSON.stringify({ records, nextCursor }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const managementClassifierFeatures = {
  messageCountBucket: "low",
  hasIncomingQuestion: false,
  hasNeedSignal: false,
  hasPermissionSignal: false,
  hasValueDiscussionSignal: false,
  hasNextStepSignal: false,
} as const;

async function announceExtension() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await act(async () => {
      window.dispatchEvent(new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: { source: LINKEDIN_EXTENSION_SOURCE, type: "CHATHELP_EXTENSION_READY", version: "0.5.1" },
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
    });
    if (screen.queryByRole("switch", { name: "Pause automatic sync" })) return;
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
  }
  await waitFor(() => expect(screen.getByRole("switch", { name: "Pause automatic sync" })).toBeTruthy());
}

async function deliverSnapshot(snapshot = automaticSnapshot()) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: { source: LINKEDIN_EXTENSION_SOURCE, type: LINKEDIN_SNAPSHOT_EVENT, payload: snapshot },
    }));
  });
}

beforeEach(async () => {
  await resetVaultForTests();
  localStorage.clear();
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia: vi.fn() }, configurable: true });
  URL.createObjectURL = vi.fn(() => "blob:local-screen-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  const saveState = document.querySelector(".save-state");
  if (saveState && !saveState.textContent?.includes("Encrypted")) {
    await waitFor(() => expect(saveState.textContent).toContain("Encrypted"), { timeout: 3_000 });
  }
  cleanup();
  await resetVaultForTests();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "userAgent", { value: desktopUserAgent, configurable: true });
});

describe("secure conversation workspace interaction", () => {
  it("creates and reopens a manual contact in the encrypted local vault", async () => {
    const user = userEvent.setup();
    const firstRender = render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Workspace navigation" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Contact context" })).toBeNull();
    expect(screen.getByLabelText("Conversation inbox")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.type(screen.getByLabelText("New contact name"), "Alex Morgan");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    expect(await within(screen.getByRole("navigation", { name: "Conversations" })).findByRole("button", { name: "Open conversation with Alex Morgan" })).toBeTruthy();
    expect(screen.getByLabelText("Conversation with Alex Morgan")).toBeTruthy();
    const contextToggle = screen.getByRole("button", { name: "Show contact details" });
    expect(contextToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("complementary", { name: "Contact context" })).toBeNull();
    await user.click(contextToggle);
    expect(screen.getByRole("complementary", { name: "Contact context" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide contact details" }).getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Hide contact details" }));
    expect(screen.queryByRole("complementary", { name: "Contact context" })).toBeNull();
    await waitFor(async () => expect((await openDeviceVault()).workspace.contacts.some((contact) => contact.name === "Alex Morgan")).toBe(true), { timeout: 3000 });

    firstRender.unmount();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    expect(await within(screen.getByRole("navigation", { name: "Conversations" })).findByRole("button", { name: "Open conversation with Alex Morgan" })).toBeTruthy();
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
  }, 20_000);

  it("automatically creates an unknown contact and updates repeated snapshots without duplication", async () => {
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();

    const conversation = await screen.findByLabelText("Conversation with Taylor Lee");
    expect(within(conversation).getAllByText("Could you share the role brief?")).toHaveLength(1);
    expect(screen.getByText("Opened LinkedIn conversation")).toBeTruthy();
    expect(screen.getAllByRole("status").some((item) => /Contact automatically added/i.test(item.textContent ?? ""))).toBe(true);

    const secondMessage = {
      id: "urn:li:msg:2",
      sourceId: "urn:li:msg:2",
      role: "me" as const,
      speaker: "You",
      body: "Absolutely—I will send it here.",
      createdAt: "2026-08-02T12:01:00.000Z",
      attachments: [],
    };
    await deliverSnapshot({ ...automaticSnapshot([...automaticSnapshot().messages, secondMessage]), captureId: "capture-ui-2" });
    await deliverSnapshot({ ...automaticSnapshot([...automaticSnapshot().messages, secondMessage]), captureId: "capture-ui-3" });
    await waitFor(() => expect(within(screen.getByLabelText("Conversation with Taylor Lee")).getAllByText("Absolutely—I will send it here.")).toHaveLength(1));
    expect(within(screen.getByRole("navigation", { name: "Conversations" })).getAllByRole("button", { name: "Open conversation with Taylor Lee" })).toHaveLength(1);
    expect(screen.getAllByRole("status").some((item) => /Existing contact updated|No new messages/i.test(item.textContent ?? ""))).toBe(true);
  });

  it("marks an in-flight encrypted backup pending when automatic sync changes the workspace", async () => {
    const workspace = createEmptyWorkspace();
    workspace.cloudRecovery.enabled = true;
    await createDeviceVault(workspace);
    const key = await importRecoveryKey((await createRecoveryBundle()).encryptionKey);
    await saveCloudRecoveryKey(key);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<ChatHelpApp />);
    expect(await screen.findByText("Syncing encrypted backup", {}, { timeout: 8_000 })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();

    expect(await screen.findAllByText("Encrypted backup pending")).not.toHaveLength(0);
  }, 15_000);

  it("keeps only user labels on tiles and persists pin, read-later, and unread state", async () => {
    const user = userEvent.setup();
    const seeded = createEmptyWorkspace();
    seeded.contacts = [{
      id: "taylor-local",
      name: "Taylor Lee",
      headline: "",
      profileNotes: "",
      platform: "linkedin",
      platformUrl: "https://www.linkedin.com/messaging/thread/taylor-lee/",
      profileUrl: "https://www.linkedin.com/in/taylor-lee/",
      conversationUrl: "https://www.linkedin.com/messaging/thread/taylor-lee/",
      company: "",
      avatarUrl: "",
      source: "linkedin-extension",
      labels: ["priority"],
      pipelineStage: "inbox",
      chat: [],
      documents: [],
      outcomes: [],
      retentionDays: 90,
    }];
    await createDeviceVault(seeded);
    const firstRender = render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();

    const inbox = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(inbox).getByText("priority", { selector: ".label-chip" })).toBeTruthy();
    for (const systemTag of ["Synced", "Inbox", "Awaiting reply", "To respond", "Read later"]) {
      expect(within(inbox).queryByText(systemTag)).toBeNull();
    }
    expect(within(inbox).getByLabelText("Unread message from Taylor Lee")).toBeTruthy();
    await user.click(within(inbox).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    expect(within(inbox).queryByLabelText("Unread message from Taylor Lee")).toBeNull();
    const pin = within(inbox).getByRole("button", { name: "Pin Taylor Lee" });
    const readLater = within(inbox).getByRole("button", { name: "Read Taylor Lee later" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(readLater.getAttribute("aria-pressed")).toBe("false");

    await user.click(pin);
    await user.click(readLater);
    expect(within(inbox).queryByText("Read later")).toBeNull();
    expect(within(inbox).getByRole("button", { name: "Unpin Taylor Lee" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(inbox).getByRole("button", { name: "Clear read later for Taylor Lee" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(document.querySelector(".save-state")?.textContent).toContain("Encrypted"), { timeout: 3_000 });

    firstRender.unmount();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    const reopenedInbox = screen.getByRole("navigation", { name: "Conversations" });
    expect(within(reopenedInbox).getByRole("button", { name: "Unpin Taylor Lee" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(reopenedInbox).getByRole("button", { name: "Clear read later for Taylor Lee" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(reopenedInbox).queryByLabelText("Unread message from Taylor Lee")).toBeNull();
  }, 20_000);

  it("shows message-free sync diagnostics and the prompt-aligned draft context inspector", async () => {
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();

    await user.click(screen.getByText("Sync diagnostics"));
    const syncDiagnostics = screen.getByRole("region", { name: "Sync diagnostics" });
    expect(within(syncDiagnostics).getByText("Permission granted")).toBeTruthy();
    expect(within(syncDiagnostics).getByText("Bridge connected")).toBeTruthy();
    expect(within(syncDiagnostics).getByText("Visible messages 1")).toBeTruthy();
    expect(within(syncDiagnostics).getByText("New messages 1")).toBeTruthy();
    expect(within(syncDiagnostics).getByText("Duplicates 0")).toBeTruthy();
    expect(within(syncDiagnostics).getByText("Result Created")).toBeTruthy();

    const composer = screen.getByRole("region", { name: "Reply to Taylor Lee" });
    await user.click(within(composer).getByText("Advanced"));
    await user.click(within(composer).getByText("Draft context"));
    const draftContext = screen.getByRole("region", { name: "Draft context" });
    expect(within(draftContext).getByText(/Socializing\/Networking playbook/)).toBeTruthy();
    expect(within(draftContext).getByText("1 conversation message included")).toBeTruthy();
    expect(within(draftContext).getByText(/reply-rule characters/)).toBeTruthy();
    expect(within(draftContext).getByText("No optional instruction")).toBeTruthy();
    expect(within(draftContext).getByText(/Could you share the role brief\?/)).toBeTruthy();
  });

  it("generates exactly one editable precise draft with stage, goal, and personal guidance", async () => {
    const request = vi.fn(async (...[path]: [RequestInfo | URL, RequestInit?]) => {
      if (String(path) === "/api/learning/status") return learningStatusResponse();
      if (String(path) === "/api/usage") return usageResponse();
      return new Response(JSON.stringify({
        draft: "I can share the brief here. Which part would be most useful to start with?",
        provider: "anthropic",
        model: "claude-opus-4-6",
        mode: "stage-aware-single-draft-v1",
        usageAccounting: "recorded",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        fallbackReason: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();
    expect(await screen.findByLabelText("Conversation with Taylor Lee")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByLabelText(/Cloud access code/)).toBeNull();
    expect(screen.getByText(/Claude Opus 4\.6 Thinking analyzes, writes, and independently reviews one reply/)).toBeTruthy();
    expect(screen.getByText(/Llama 3\.1 8B and GPT-OSS 120B remain available as the permanent Cloudflare fallback/)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Personal conversation guidelines" }), "Prefer plain language and one useful question.");
    expect(screen.getByText("46 / 2,000 characters")).toBeTruthy();
    const consent = screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ });
    expect(consent.closest("label")?.textContent).toMatch(/Anthropic.*Cloudflare-hosted fallback/);
    await user.click(consent);
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    expect((screen.getByLabelText("Optional instruction") as HTMLTextAreaElement).value).toBe("");
    await user.click(within(screen.getByRole("region", { name: "Reply to Taylor Lee" })).getByText("Advanced"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Relationship stage" }), "learn_interests");
    await user.type(screen.getByRole("textbox", { name: "Conversation goal" }), "Learn which role detail matters most.");
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));

    expect(await screen.findByLabelText("Edit draft 1")).toBeTruthy();
    expect(screen.queryByLabelText("Edit draft 2")).toBeNull();
    expect(request.mock.calls.filter(([path]) => path === "/api/drafts")).toHaveLength(1);
    const draftCall = request.mock.calls.find(([path]) => path === "/api/drafts");
    expect(draftCall?.[1]?.credentials).toBe("same-origin");
    const requestBody = JSON.parse(draftCall?.[1]?.body as string);
    expect(requestBody.replyObjective).toBe("");
    expect(requestBody.conversationContext).toContain("Could you share the role brief?");
    expect(requestBody.playbook.rulebookFull).toBeTruthy();
    expect(requestBody.playbook.rulebookDigest).toBeTruthy();
    expect(requestBody.personalGuidelines).toBe("Prefer plain language and one useful question.");
    expect(requestBody.relationshipStage).toBe("learn_interests");
    expect(requestBody.conversationGoal).toBe("Learn which role detail matters most.");
    expect(requestBody.latestMeaningfulIncoming).toMatchObject({ sender: "CONTACT", text: "Could you share the role brief?" });
    expect(screen.getByText(/Generated one precise draft with Claude Opus 4.6/i)).toBeTruthy();
    const progressToggle = screen.getByRole("button", { name: "Show AI steps" });
    expect(progressToggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(progressToggle);
    expect(screen.getByText("Finalizing precise draft").closest("li")?.dataset.status).toBe("done");
    expect(screen.getByRole("link", { name: /Open LinkedIn to review and paste/ })).toBeTruthy();
  }, 20_000);

  it("refreshes the server allowance after generation and when Settings opens without appending local usage", async () => {
    const totals = {
      uncachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
      cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, promptTokens: 0, completionTokens: 0,
      totalTokens: 0, estimatedNeurons: 0,
    };
    const usage = {
      periodStart: "2026-08-01T00:00:00.000Z",
      nextResetAt: "2026-09-01T00:00:00.000Z",
      providers: {
        anthropic: { provider: "anthropic", consumedMicroUsd: 0, allowanceMicroUsd: 10_000_000, remainingMicroUsd: 10_000_000, quality: "unavailable", totals, models: [] },
        workersAi: { provider: "workers_ai", consumedMicroUsd: 0, allowanceMicroUsd: 2_000_000, remainingMicroUsd: 2_000_000, quality: "unavailable", totals, models: [] },
      },
    };
    const request = vi.fn(async (...[path]: [RequestInfo | URL, RequestInit?]) => {
      if (String(path) === "/api/usage") return new Response(JSON.stringify(usage), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({
        draft: "A server-accounted reply.", provider: "anthropic", model: "claude-opus-4-6",
        mode: "stage-aware-single-draft-v1", usageAccounting: "recorded", requestId: "123e4567-e89b-42d3-a456-426614174000", fallbackReason: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await announceExtension();
    await deliverSnapshot();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));

    expect(await screen.findByDisplayValue("A server-accounted reply.")).toBeTruthy();
    await waitFor(async () => expect((await openDeviceVault()).workspace.contacts[0].draftHistory?.[0]?.drafts).toEqual(["A server-accounted reply."]));
    expect((await openDeviceVault()).workspace.aiUsage).toEqual([]);
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "/api/usage")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "/api/usage")).toHaveLength(3));
  }, 20_000);

  it("shows automatic approved cloud learning while keeping provider-assisted drafts out of retrieval", async () => {
    const request = vi.fn(async (...[path]: [RequestInfo | URL, RequestInit?]) => {
      if (String(path) === "/api/learning/status") return learningStatusResponse();
      if (String(path) === "/api/usage") return usageResponse();
      return new Response(JSON.stringify({
        draft: "I can share the brief. Which part would be most useful to explore first?",
        provider: "anthropic",
        model: "claude-opus-4-6",
        mode: "stage-aware-single-draft-v1",
        usageAccounting: "recorded",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
        fallbackReason: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await announceExtension();
    await deliverSnapshot();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Cloud learning enabled")).toBeTruthy();
    expect(screen.getByText(/server-readable in Neon for retrieval and future training preparation/i)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Enable encrypted personal learning" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    await screen.findByLabelText("Edit draft 1");
    const draftCall = request.mock.calls.find(([path]) => path === "/api/drafts");
    expect(JSON.parse(draftCall?.[1]?.body as string)).not.toHaveProperty("learningExamples");

    const draftCard = screen.getByLabelText("Edit draft 1").closest("article");
    expect(draftCard).toBeTruthy();
    for (const label of ["Copy", "Useful", "Not useful"]) expect(within(draftCard as HTMLElement).getByRole("button", { name: label })).toBeTruthy();
    for (const label of ["Save improvement", "Mark sent", "More", "Save edit", "Reject"]) {
      expect(within(draftCard as HTMLElement).queryByRole("button", { name: label })).toBeNull();
    }
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByText("Provider-assisted by default")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Preferred response for learning" })).toBeNull();
  }, 30_000);

  it("shows only one response from legacy three-draft history", async () => {
    const workspace = createEmptyWorkspace();
    workspace.inboxRole = "Network Marketing";
    workspace.contacts = [{
      id: "legacy-drafts-contact",
      name: "Amit Dabral",
      headline: "",
      profileNotes: "",
      platform: "linkedin",
      platformUrl: "",
      chat: [{ id: "incoming", role: "them", body: "Happy to connect.", createdAt: "2026-08-02T11:59:00.000Z" }],
      documents: [],
      outcomes: [],
      retentionDays: 90,
      draftHistory: [{
        id: "legacy-three-draft-set",
        agenda: "Continue the conversation",
        drafts: ["First legacy response", "Second legacy response", "Third legacy response"],
        createdAt: "2026-08-02T12:00:00.000Z",
        role: "Network Marketing",
      }],
    }];
    await createDeviceVault(workspace);

    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });

    expect((screen.getByLabelText("Edit draft 1") as HTMLTextAreaElement).value).toBe("First legacy response");
    expect(screen.queryByLabelText("Edit draft 2")).toBeNull();
    expect(screen.getByRole("button", { name: "Generate Precise Draft" })).toBeTruthy();
  });

  it("keeps direct draft actions free of legacy controls and LinkedIn commands", async () => {
    const workspace = createEmptyWorkspace();
    workspace.contacts = [{
      id: "manual-send-boundary",
      name: "Taylor Lee",
      headline: "",
      profileNotes: "",
      platform: "linkedin",
      platformUrl: "https://www.linkedin.com/messaging/thread/taylor-lee/",
      chat: [{ id: "incoming", role: "them", body: "Happy to connect.", createdAt: "2026-08-02T11:59:00.000Z" }],
      documents: [],
      outcomes: [],
      retentionDays: 90,
      draftHistory: [{ id: "manual-send-draft", agenda: "", drafts: ["Thanks for connecting."], createdAt: "2026-08-02T12:00:00.000Z", role: workspace.inboxRole }],
    }];
    await createDeviceVault(workspace);
    const postMessage = vi.spyOn(window, "postMessage");
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });

    for (const label of ["Copy", "Useful", "Not useful"]) expect(screen.getByRole("button", { name: label })).toBeTruthy();
    for (const label of ["Save improvement", "Rate this draft", "Mark sent", "More", "Dismiss", "Accept", "Save edit", "Reject"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
    expect(postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === LINKEDIN_SYNC_COMMAND_EVENT)).toBe(false);
    expect((screen.getByLabelText("Edit draft 1") as HTMLTextAreaElement).value).toBe("Thanks for connecting.");
  });

  it("sends neither stored feedback summaries nor learning examples from the browser", async () => {
    const workspace = createEmptyWorkspace();
    workspace.cloudInference.consentedAt = "2026-08-01T00:00:00.000Z";
    workspace.personalLearning.enabled = true;
    workspace.inboxRole = "Network Marketing";
    workspace.contacts = [{
      id: "learning-contact",
      name: "Taylor Lee",
      headline: "Talent Partner",
      profileNotes: "",
      platform: "linkedin",
      platformUrl: "",
      chat: [{ id: "incoming", role: "them", body: "What kind of work are you focused on?", createdAt: "2026-08-02T11:59:00.000Z" }],
      documents: [],
      outcomes: [],
      retentionDays: 90,
      relationshipStage: "learn_interests",
      conversationGoal: "Learn which professional priorities matter most",
    }];
    workspace.feedback = Array.from({ length: 5 }, (_, index) => ({
      id: `approved-${index}`,
      contactId: `other-contact-${index}`,
      role: "Network Marketing" as const,
      relationshipStage: "learn_interests" as const,
      conversationGoal: "Learn which professional priorities matter most",
      provider: "local" as const,
      modelId: "independent-user-example",
      action: "edited" as const,
      draft: "",
      preferredResponse: `Approved response ${index}`,
      outcome: "",
      reason: "LOCAL FEEDBACK SUMMARY MUST STAY IN THE BROWSER",
      origin: "independently_user_authored" as const,
      independentlyAuthoredAttested: true,
      eligibleForRetrieval: true,
      enabled: true,
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
      updatedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
    }));
    await createDeviceVault(workspace);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      draft: "I focus on helping people explore options that fit their priorities. What matters most in your work right now?",
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "stage-aware-single-draft-v1",
      usageAccounting: "recorded",
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      fallbackReason: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));

    await screen.findByLabelText("Edit draft 1");
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body).not.toHaveProperty("feedbackSummary");
    expect(body).not.toHaveProperty("learningExamples");
    expect(JSON.stringify(body)).not.toContain("LOCAL FEEDBACK SUMMARY MUST STAY IN THE BROWSER");
    expect(JSON.stringify(body)).not.toContain("Approved response");
    expect(JSON.stringify(body)).not.toContain("other-contact");
  }, 20_000);

  it("keeps a local stage suggestion non-authoritative until the user applies it", async () => {
    const workspace = createEmptyWorkspace();
    workspace.personalLearning.enabled = true;
    workspace.inboxRole = "Network Marketing";
    workspace.contacts = [{
      id: "stage-contact",
      name: "Taylor Lee",
      headline: "Talent Partner",
      profileNotes: "",
      platform: "linkedin",
      platformUrl: "",
      chat: [{ id: "incoming", role: "them", body: "I am thinking about my career priorities.", createdAt: "2026-08-02T11:59:00.000Z" }],
      documents: [],
      outcomes: [],
      retentionDays: 90,
      relationshipStage: "new_connection",
      conversationGoal: "Learn about career priorities",
    }];
    (workspace as unknown as { stageTrainingRecords: unknown[] }).stageTrainingRecords = Array.from({ length: 4 }, (_, index) => ({
      id: `confirmation-${index}`,
      featureSchemaVersion: 1,
      role: "Network Marketing",
      messageCountBucket: "low",
      hasIncomingQuestion: false,
      hasNeedSignal: false,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: ["career", "priorities"],
      confirmedStage: "learn_interests",
      humanConfirmed: true,
      createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
    }));
    await createDeviceVault(workspace);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });

    await user.click(within(screen.getByRole("region", { name: "Reply to Taylor Lee" })).getByText("Advanced"));
    const stageSelect = screen.getByRole("combobox", { name: "Relationship stage" }) as HTMLSelectElement;
    expect(stageSelect.value).toBe("new_connection");
    expect(screen.getByText(/Suggested stage: Learn interests and situation/)).toBeTruthy();
    expect(stageSelect.value).toBe("new_connection");
    await user.click(screen.getByRole("button", { name: "Apply suggested relationship stage" }));
    expect(stageSelect.value).toBe("learn_interests");
    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace as unknown as { stageTrainingRecords: unknown[] };
      expect(reopened.stageTrainingRecords).toHaveLength(5);
    });
  }, 20_000);

  it("retains pending cloud learning until a user retry receives an acknowledgement", async () => {
    const workspace = createEmptyWorkspace();
    workspace.stageTrainingRecords = [{
      id: "stage-pending",
      featureSchemaVersion: 1,
      role: "Human Resource",
      messageCountBucket: "low",
      hasIncomingQuestion: false,
      hasNeedSignal: false,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: [],
      confirmedStage: "new_connection",
      humanConfirmed: true,
      createdAt: "2026-08-09T00:00:00.000Z",
    }];
    workspace.pendingLearningRecords = [{
      mutationKind: "record_upload",
      recordId: "record-pending",
      recordKind: "classifier",
      sanitizedPayload: {
        recordKind: "classifier",
        roleId: "human_resource",
        relationshipStage: "new_connection",
        goalCategory: "connect",
        provenance: "human_confirmed",
        classifierFeatures: {
          messageCountBucket: "low",
          hasIncomingQuestion: false,
          hasNeedSignal: false,
          hasPermissionSignal: false,
          hasValueDiscussionSignal: false,
          hasNextStepSignal: false,
        },
      },
      sourceCollection: "stageTrainingRecords",
      sourceLocalId: "stage-pending",
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    }];
    await createDeviceVault(workspace);
    let uploadAttempts = 0;
    const request = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path) === "/api/learning/status") return learningStatusResponse();
      if (String(path) === "/api/learning/records" && init?.method === "PUT") {
        uploadAttempts += 1;
        if (uploadAttempts === 1) throw new Error("offline");
        return new Response(JSON.stringify({
          accepted: [{ recordId: "record-pending", contentDigest: "a".repeat(64) }],
          duplicates: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(path)}`);
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("Cloud learning sync pending")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry cloud learning sync" }));
    await waitFor(async () => expect((await openDeviceVault()).workspace.pendingLearningRecords).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Retry cloud learning sync" }));
    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace;
      expect(reopened.pendingLearningRecords).toEqual([]);
      expect(reopened.stageTrainingRecords).toEqual([]);
    });
    expect(request.mock.calls.filter(([path, init]) => path === "/api/learning/records" && init?.method === "PUT")).toHaveLength(2);
  }, 20_000);

  it("persists acknowledged cloud learning while another encrypted record remains pending", async () => {
    const workspace = createEmptyWorkspace();
    workspace.stageTrainingRecords = ["accepted", "pending"].map((suffix) => ({
      id: `stage-${suffix}`,
      featureSchemaVersion: 1 as const,
      role: "Human Resource" as const,
      messageCountBucket: "low" as const,
      hasIncomingQuestion: false,
      hasNeedSignal: false,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: [],
      confirmedStage: "new_connection" as const,
      humanConfirmed: true,
      createdAt: "2026-08-09T00:00:00.000Z",
    }));
    workspace.pendingLearningRecords = ["accepted", "pending"].map((suffix) => ({
      mutationKind: "record_upload" as const,
      recordId: `record-${suffix}`,
      recordKind: "classifier" as const,
      sanitizedPayload: {
        recordKind: "classifier",
        roleId: "human_resource",
        relationshipStage: "new_connection",
        goalCategory: "connect",
        provenance: "human_confirmed",
        classifierFeatures: {
          messageCountBucket: "low",
          hasIncomingQuestion: false,
          hasNeedSignal: false,
          hasPermissionSignal: false,
          hasValueDiscussionSignal: false,
          hasNextStepSignal: false,
        },
      },
      sourceCollection: "stageTrainingRecords" as const,
      sourceLocalId: `stage-${suffix}`,
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2027-08-09T00:00:00.000Z",
    }));
    await createDeviceVault(workspace);
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path) === "/api/learning/status") return learningStatusResponse();
      if (String(path) === "/api/learning/records" && init?.method === "PUT") {
        return new Response(JSON.stringify({
          accepted: [{ recordId: "record-accepted", contentDigest: "c".repeat(64) }],
          duplicates: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(path)}`);
    }));
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));

    await user.click(screen.getByRole("button", { name: "Retry cloud learning sync" }));

    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace;
      expect(reopened.pendingLearningRecords.map((record) => record.recordId)).toEqual(["record-pending"]);
      expect(reopened.stageTrainingRecords.map((record) => record.id)).toEqual(["stage-pending"]);
      expect(reopened.cloudLearningSync).toEqual([expect.objectContaining({
        recordId: "record-accepted",
        contentDigest: "c".repeat(64),
        status: "synced",
      })]);
    });
    expect(screen.getByText("Cloud learning sync pending")).toBeTruthy();
  }, 20_000);

  it("preserves ordinary workspace updates made while a cloud learning retry is in flight", async () => {
    const workspace = createEmptyWorkspace();
    workspace.guidance.voice = "Stale custom voice";
    workspace.stageTrainingRecords = [{ id: "stage-pending", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }];
    workspace.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-pending", recordKind: "classifier", sanitizedPayload: { recordKind: "classifier", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", provenance: "human_confirmed", classifierFeatures: { messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false } }, sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-pending", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];
    await createDeviceVault(workspace);
    let resolveUpload!: (response: Response) => void;
    const request = vi.fn((path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path) === "/api/learning/status") return Promise.resolve(learningStatusResponse());
      if (String(path) === "/api/learning/records" && init?.method === "PUT") {
        return new Promise<Response>((resolve) => { resolveUpload = resolve; });
      }
      return Promise.reject(new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(path)}`));
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));

    await user.click(screen.getByRole("button", { name: "Retry cloud learning sync" }));
    await waitFor(() => expect(request.mock.calls.filter(([path, init]) => path === "/api/learning/records" && init?.method === "PUT")).toHaveLength(1));
    await user.clear(screen.getByRole("textbox", { name: "How your messages should sound" }));
    await deliverSnapshot();
    await act(async () => resolveUpload(new Response(JSON.stringify({
      accepted: [{ recordId: "record-pending", contentDigest: "a".repeat(64) }],
      duplicates: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace;
      expect(reopened.contacts.map((contact) => contact.name)).toContain("Taylor Lee");
      expect(reopened.contacts.find((contact) => contact.name === "Taylor Lee")?.chat.map((message) => message.body)).toEqual(["Could you share the role brief?"]);
      expect(reopened.guidance.voice).toBe("");
      expect(reopened.pendingLearningRecords).toEqual([]);
      expect(reopened.cloudLearningSync).toEqual([expect.objectContaining({ recordId: "record-pending", status: "synced" })]);
    });
  }, 20_000);

  it("deletes an individual synced learning record locally only after server success", async () => {
    const workspace = createEmptyWorkspace();
    workspace.cloudLearningSync = [
      { recordId: "record-1", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" },
      { recordId: "record-2", contentDigest: "b".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];
    await createDeviceVault(workspace);
    vi.stubGlobal("confirm", vi.fn(() => true));
    let deleteAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path) === "/api/learning/status") return learningStatusResponse({ counts: { classifier: 2, evaluation: 0, generative: 0 } });
      if (String(path) === "/api/learning/records" && init?.method === "GET") return learningRecordsResponse([
        { recordId: "record-1", recordKind: "classifier", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", classifierFeatures: managementClassifierFeatures, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" },
        { recordId: "record-2", recordKind: "classifier", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", classifierFeatures: managementClassifierFeatures, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" },
      ]);
      if (String(path) === "/api/learning/records/record-1" && init?.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("offline");
        return new Response(JSON.stringify({ deleted: true, recordId: "record-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(path)}`);
    }));
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByText("Advanced"));
    expect(await screen.findByText("2 loaded")).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "Delete classifier learning record" })[0]);
    await waitFor(async () => expect((await openDeviceVault()).workspace.cloudLearningSync.map((entry) => entry.recordId)).toEqual(["record-1", "record-2"]));
    expect(screen.getByText("Cloud learning deletion pending")).toBeTruthy();

    await user.click(screen.getAllByRole("button", { name: "Delete classifier learning record" })[0]);
    await waitFor(async () => expect((await openDeviceVault()).workspace.cloudLearningSync.map((entry) => entry.recordId)).toEqual(["record-2"]));
  }, 20_000);

  it("disables and deletes eligible learning locally only after server success while preserving ordinary history", async () => {
    const workspace = createEmptyWorkspace();
    workspace.contacts = [{
      id: "contact-1", name: "Alex", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
      chat: [{ id: "message-1", role: "them", body: "Keep this ordinary message", createdAt: "2026-08-09T00:00:00.000Z" }],
      documents: [], outcomes: [], retentionDays: 90,
      draftHistory: [{ id: "draft-1", agenda: "Keep this draft", drafts: ["Ordinary draft"], createdAt: "2026-08-09T00:00:00.000Z" }],
    }];
    workspace.feedback = [
      { id: "eligible", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "Keep eligible feedback", outcome: "", reason: "", origin: "independently_user_authored", independentlyAuthoredAttested: true, eligibleForRetrieval: true, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
      { id: "ordinary-feedback", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "Ordinary feedback", preferredResponse: "", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];
    workspace.stageTrainingRecords = [{ id: "stage-1", featureSchemaVersion: 1, role: "Human Resource", messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection", humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }];
    workspace.pendingLearningRecords = [{ mutationKind: "record_upload", recordId: "record-1", recordKind: "classifier", sanitizedPayload: { recordKind: "classifier", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", provenance: "human_confirmed", classifierFeatures: { messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false } }, sourceCollection: "stageTrainingRecords", sourceLocalId: "stage-1", createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }];
    workspace.cloudLearningSync = [{ recordId: "record-2", contentDigest: "a".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" }];
    await createDeviceVault(workspace);
    vi.stubGlobal("confirm", vi.fn(() => true));
    let deleteAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path) === "/api/learning/status") return learningStatusResponse({ counts: { classifier: 1, evaluation: 0, generative: 1 } });
      if (String(path) === "/api/learning" && init?.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new Error("offline");
        return new Response(JSON.stringify({ enabled: false, deleted: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(path)}`);
    }));
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));

    await user.click(screen.getByRole("button", { name: "Disable and delete cloud learning" }));
    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace;
      expect(reopened.personalLearning.enabled).toBe(true);
      expect(reopened.feedback.map((item) => item.id)).toEqual(["eligible", "ordinary-feedback"]);
      expect(reopened.pendingLearningRecords).toHaveLength(1);
      expect(reopened.cloudLearningSync).toHaveLength(1);
    });

    await user.click(screen.getByRole("button", { name: "Disable and delete cloud learning" }));
    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace;
      expect(reopened.personalLearning.enabled).toBe(false);
      expect(reopened.feedback.map((item) => item.id)).toEqual(["ordinary-feedback"]);
      expect(reopened.stageTrainingRecords).toEqual([]);
      expect(reopened.pendingLearningRecords).toEqual([]);
      expect(reopened.cloudLearningSync).toEqual([]);
      expect(reopened.contacts[0].chat.map((message) => message.body)).toEqual(["Keep this ordinary message"]);
      expect((reopened.contacts[0].draftHistory ?? []).map((history) => history.drafts)).toEqual([["Ordinary draft"]]);
    });
  }, 20_000);

  it("persists monotonic learning deletion markers while encrypted recovery is enabled", async () => {
    const workspace = createEmptyWorkspace();
    workspace.cloudRecovery.enabled = true;
    workspace.contacts = [{
      id: "contact-1", name: "Alex", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "",
      chat: [{ id: "message-1", role: "them", body: "Keep this message", createdAt: "2026-08-09T00:00:00.000Z" }],
      documents: [], outcomes: [], retentionDays: 90,
      draftHistory: [{ id: "draft-1", agenda: "Keep", drafts: ["Keep this draft"], createdAt: "2026-08-09T00:00:00.000Z" }],
    }];
    workspace.feedback = [
      { id: "eligible", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "", preferredResponse: "Eligible", outcome: "", reason: "", origin: "independently_user_authored", independentlyAuthoredAttested: true, eligibleForRetrieval: true, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
      { id: "ordinary", contactId: "contact-1", role: "Human Resource", relationshipStage: "new_connection", conversationGoal: "", provider: "local", modelId: "", action: "accepted", draft: "Ordinary feedback", preferredResponse: "", outcome: "", reason: "", origin: "provider_assisted", independentlyAuthoredAttested: false, eligibleForRetrieval: false, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" },
    ];
    workspace.stageTrainingRecords = ["acknowledged", "pending"].map((suffix) => ({ id: `stage-${suffix}`, featureSchemaVersion: 1 as const, role: "Human Resource" as const, messageCountBucket: "low" as const, hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false, semanticTokens: [], confirmedStage: "new_connection" as const, humanConfirmed: true, createdAt: "2026-08-09T00:00:00.000Z" }));
    workspace.pendingLearningRecords = ["acknowledged", "pending"].map((suffix) => ({ mutationKind: "record_upload" as const, recordId: `record-${suffix}`, recordKind: "classifier" as const, sanitizedPayload: { recordKind: "classifier", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", provenance: "human_confirmed", classifierFeatures: { messageCountBucket: "low", hasIncomingQuestion: false, hasNeedSignal: false, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false } }, sourceCollection: "stageTrainingRecords" as const, sourceLocalId: `stage-${suffix}`, createdAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" }));
    workspace.cloudLearningSync = [{ recordId: "record-delete", contentDigest: "f".repeat(64), status: "synced", updatedAt: "2026-08-09T00:00:00.000Z" }];
    await createDeviceVault(workspace);
    await saveCloudRecoveryKey(await importRecoveryKey((await createRecoveryBundle()).encryptionKey));
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/vault") return new Promise<Response>(() => undefined);
      if (path === "/api/learning/status" && init?.method === "GET") return learningStatusResponse({ counts: { classifier: 2, evaluation: 0, generative: 0 } });
      if (path === "/api/learning/records" && init?.method === "GET") return learningRecordsResponse([
        { recordId: "record-delete", recordKind: "classifier", roleId: "human_resource", relationshipStage: "new_connection", goalCategory: "connect", classifierFeatures: managementClassifierFeatures, enabled: true, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2027-08-09T00:00:00.000Z" },
      ]);
      if (path === "/api/learning/records" && init?.method === "PUT") return new Response(JSON.stringify({ accepted: [{ recordId: "record-acknowledged", contentDigest: "a".repeat(64) }], duplicates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/learning/records/record-delete" && init?.method === "DELETE") return new Response(JSON.stringify({ deleted: true, recordId: "record-delete" }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/learning" && init?.method === "DELETE") return new Response(JSON.stringify({ enabled: false, deleted: 2 }), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    }));
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));

    await user.click(screen.getByRole("button", { name: "Retry cloud learning sync" }));
    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace;
      expect(reopened.pendingLearningRecords.map((row) => row.recordId)).toEqual(["record-pending"]);
      expect(reopened.cloudLearningDeletionMarkers).toEqual([expect.objectContaining({ recordId: "record-acknowledged", disposition: "acknowledged", sourceLocalId: "stage-acknowledged" })]);
    });

    await user.click(await screen.findByText("Advanced"));
    expect(await screen.findByText("1 loaded")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete classifier learning record" }));
    await waitFor(async () => expect((await openDeviceVault()).workspace.cloudLearningDeletionMarkers).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: "record-delete", disposition: "deleted" })])));

    await user.click(screen.getByRole("button", { name: "Disable and delete cloud learning" }));
    await waitFor(async () => {
      const reopened = (await openDeviceVault()).workspace;
      expect(reopened.cloudLearningClearedAt).not.toBe("");
      expect(reopened.feedback.map((row) => row.id)).toEqual(["ordinary"]);
      expect(reopened.stageTrainingRecords).toEqual([]);
      expect(reopened.pendingLearningRecords).toEqual([]);
      expect(reopened.cloudLearningSync).toEqual([]);
      expect(reopened.contacts[0].chat.map((message) => message.body)).toEqual(["Keep this message"]);
      expect((reopened.contacts[0].draftHistory ?? []).map((history) => history.drafts)).toEqual([["Keep this draft"]]);
      expect(reopened.cloudRecovery.enabled).toBe(true);
    });
  }, 20_000);

  it("previews and downloads approved training exports without a LoRA upload action", async () => {
    await createDeviceVault(createEmptyWorkspace());
    vi.stubGlobal("fetch", vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      if (String(path) === "/api/learning/status") {
        return learningStatusResponse({ counts: { classifier: 1, evaluation: 0, generative: 1 } });
      }
      if (String(path) === "/api/learning/records" && init?.method === "GET") {
        return learningRecordsResponse([
          { recordId: "classifier-safe-metadata", recordKind: "classifier", roleId: "network_marketing", relationshipStage: "learn_interests", goalCategory: "discover_interests", classifierFeatures: { messageCountBucket: "medium", hasIncomingQuestion: true, hasNeedSignal: true, hasPermissionSignal: false, hasValueDiscussionSignal: false, hasNextStepSignal: false }, enabled: true, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2027-08-01T00:00:00.000Z" },
          { recordId: "authored-safe-target", recordKind: "generative", roleId: "network_marketing", relationshipStage: "learn_interests", goalCategory: "discover_interests", enabled: true, target: "Which priority would be most useful to explore?", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2027-08-01T00:00:00.000Z" },
        ]);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(path)}`);
    }));
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("1 classifier / 0 evaluation / 1 authored examples")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download manifest" })).toBeNull();
    await user.click(await screen.findByText("Advanced"));
    expect(await screen.findByText("2 loaded")).toBeTruthy();
    expect(await screen.findByText("1 exportable classifier records loaded")).toBeTruthy();
    expect(await screen.findByText("1 sanitized authored examples loaded")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Download classifier JSONL" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Download manifest" }));
    await user.click(screen.getByRole("button", { name: "Download classifier JSONL" }));
    await user.click(screen.getByRole("button", { name: "Download user-authored JSONL" }));
    expect(anchorClick).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("button", { name: /upload.*LoRA/i })).toBeNull();
  }, 20_000);

  it("shows real AI stages behind a persistent accessible arrow panel", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const request = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    }), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await announceExtension();
    await deliverSnapshot();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));

    const objective = screen.getByRole("textbox", { name: "Optional instruction" });
    const promptComposer = objective.closest(".prompt-composer");
    expect(promptComposer).toBeTruthy();
    expect(within(promptComposer as HTMLElement).getByRole("button", { name: "Generate Precise Draft" })).toBeTruthy();
    expect(promptComposer?.querySelector(".prompt-composer-actions")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    const stopButton = screen.getByRole("button", { name: "Stop generating draft" });
    expect((stopButton as HTMLButtonElement).disabled).toBe(false);
    expect(stopButton.getAttribute("aria-busy")).toBe("true");
    expect(stopButton.querySelector(".draft-button-spinner")).toBeTruthy();
    expect(stopButton.querySelector(".draft-stop-symbol")).toBeTruthy();
    expect(stopButton.textContent).not.toContain("Generating");
    const progressToggle = screen.getByRole("button", { name: "Show AI steps" });
    expect(progressToggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(progressToggle);
    expect(progressToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Analyzing conversation stage")).toBeTruthy();

    streamController?.enqueue(encoder.encode('event: stage\ndata: {"stage":"analyzing","status":"in-progress"}\n\n'));
    streamController?.enqueue(encoder.encode('event: stage\ndata: {"stage":"analyzing","status":"done"}\n\nevent: stage\ndata: {"stage":"drafting","status":"in-progress"}\n\n'));
    await waitFor(() => expect(screen.getByText("Writing one precise reply").closest("li")?.dataset.status).toBe("in-progress"));
    streamController?.enqueue(encoder.encode('event: stage\ndata: {"stage":"drafting","status":"done"}\n\nevent: stage\ndata: {"stage":"reviewing","status":"in-progress"}\n\nevent: stage\ndata: {"stage":"reviewing","status":"done"}\n\nevent: stage\ndata: {"stage":"finalizing","status":"in-progress"}\n\nevent: stage\ndata: {"stage":"finalizing","status":"done"}\n\nevent: result\ndata: {"draft":"One precise reply","provider":"anthropic","model":"claude-opus-4-6","mode":"stage-aware-single-draft-v1","usageAccounting":"recorded","requestId":"123e4567-e89b-42d3-a456-426614174000","fallbackReason":null}\n\n'));
    streamController?.close();

    expect((await screen.findByRole("button", { name: "Generate Precise Draft" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Hide AI steps" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Finalizing precise draft").closest("li")?.dataset.status).toBe("done");
    expect(screen.getByLabelText("Edit draft 1")).toBeTruthy();
  }, 20_000);

  it("lets the user stop an in-flight draft request from the animated symbol control", async () => {
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await announceExtension();
    await deliverSnapshot();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));

    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    const stopButton = screen.getByRole("button", { name: "Stop generating draft" });
    expect(stopButton.textContent).not.toContain("Generating");
    await user.click(stopButton);

    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(await screen.findByRole("button", { name: "Generate Precise Draft" })).toBeTruthy();
    expect(screen.queryByText("Draft was not generated.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show AI steps" })).toBeNull();
  }, 20_000);

  it("uploads, combines, saves, and downloads the selected role's rules document", async () => {
    const user = userEvent.setup();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const postMessage = vi.spyOn(window, "postMessage");
    const rendered = render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable automatic LinkedIn conversation sync" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "About automatic LinkedIn conversation sync" })).toBeTruthy();
    await announceExtension();
    const syncSwitch = screen.getByRole("switch", { name: "Pause automatic sync" });
    expect(syncSwitch.getAttribute("aria-checked")).toBe("true");
    await user.click(syncSwitch);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: LINKEDIN_SYNC_COMMAND_EVENT, command: "pause" }), expect.any(String));
    await user.click(screen.getByText("More"));
    expect(screen.getByRole("button", { name: "One-time manual capture" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Disable and revoke LinkedIn permission" }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: LINKEDIN_SYNC_COMMAND_EVENT, command: "disable" }), expect.any(String));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "One-time manual capture" })).toBeNull();

    const tailMarker = "FINAL-LONG-UI-RULE";
    const longRules = "Be factual and grounded. ".repeat(1_000) + tailMarker;
    fireEvent.change(screen.getByLabelText("Rules every reply must follow"), { target: { value: longRules } });
    expect((screen.getByLabelText("Rules every reply must follow") as HTMLTextAreaElement).value).toContain(tailMarker);
    expect(screen.getByText(`${longRules.length.toLocaleString()} / 50,000 characters`)).toBeTruthy();

    const uploadedRule = "UPLOADED-RULE: Ask only one relevant question.";
    const file = new File([uploadedRule], "human-resource-rules.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => uploadedRule });
    const fileInput = rendered.container.querySelector('input[accept*=".txt"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(await screen.findByText(/Loaded human-resource-rules.md.*encrypted the combined text/)).toBeTruthy();
    const combinedRules = (screen.getByLabelText("Rules every reply must follow") as HTMLTextAreaElement).value;
    expect(combinedRules).toContain(tailMarker);
    expect(combinedRules).toContain(uploadedRule);

    await user.click(screen.getByRole("button", { name: "Save playbook settings" }));
    expect(await screen.findByText(/All four messaging playbooks were saved/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Download rules" }));
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Downloaded the current .* reply rules as text/)).toBeTruthy();
  }, 30_000);

  it("keeps role playbooks isolated and applies the persisted Inbox role to every draft request", async () => {
    const drafts = [
      { draft: "Network draft one", provider: "cloudflare", model: "@cf/meta/llama-3.1-8b-instruct-fast + @cf/openai/gpt-oss-120b", fallbackReason: "anthropic-pipeline-failed" },
      { draft: "HR draft one", provider: "anthropic", model: "claude-opus-4-6", fallbackReason: null },
    ];
    const request = vi.fn(async (...[path]: [RequestInfo | URL, RequestInit?]) => {
      if (String(path) === "/api/usage") return usageResponse();
      if (String(path) === "/api/learning/status") return learningStatusResponse();
      const next = drafts.shift();
      if (!next) throw new Error("Unexpected draft request");
      return new Response(JSON.stringify({ ...next, mode: "stage-aware-single-draft-v1", usageAccounting: "recorded", requestId: "123e4567-e89b-42d3-a456-426614174000" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const firstRender = render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settingsRole = screen.getByLabelText("Your role or team");
    await user.selectOptions(settingsRole, "Network Marketing");
    await user.clear(screen.getByLabelText("Your relationship goal"));
    await user.type(screen.getByLabelText("Your relationship goal"), "NETWORK-ONLY-GOAL");
    await user.clear(screen.getByLabelText("Rules every reply must follow"));
    await user.type(screen.getByLabelText("Rules every reply must follow"), "Always answer the newest message.\nNever invent facts.\nNETWORK-ONLY-RULES");
    await user.selectOptions(settingsRole, "Human Resource");
    await user.clear(screen.getByLabelText("Your relationship goal"));
    await user.type(screen.getByLabelText("Your relationship goal"), "HR-ONLY-GOAL");
    await user.clear(screen.getByLabelText("Rules every reply must follow"));
    await user.type(screen.getByLabelText("Rules every reply must follow"), "HR-ONLY-RULES");
    await user.selectOptions(settingsRole, "Network Marketing");
    expect((screen.getByLabelText("Your relationship goal") as HTMLTextAreaElement).value).toBe("NETWORK-ONLY-GOAL");
    expect((screen.getByLabelText("Rules every reply must follow") as HTMLTextAreaElement).value).toContain("NETWORK-ONLY-RULES");
    await user.click(screen.getByRole("button", { name: "Save playbook settings" }));
    expect(await screen.findByText(/All four messaging playbooks were saved/)).toBeTruthy();
    expect((await openDeviceVault()).workspace.guidance.playbooks["Network Marketing"].rulebookDigest).toBe([
      "- Always answer the newest message.",
      "- Never invent facts.",
    ].join("\n"));
    expect(screen.queryByLabelText(/Cloud access code/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));

    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("region", { name: "Reply to Taylor Lee" })).getByText("Advanced"));
    const inboxRole = screen.getByLabelText("Your role or team");
    expect(inboxRole.closest(".composer-card")).toBeTruthy();
    expect(firstRender.container.querySelector(".conversation-scroll[aria-label='Conversation history']")).toBeTruthy();
    expect(firstRender.container.querySelector(".drafting-scroll[aria-label='Draft composer and generated responses']")).toBeTruthy();
    expect(firstRender.container.querySelector(".inbox-role-select")).toBeNull();
    await user.selectOptions(inboxRole, "Network Marketing");
    expect(screen.getByText("Using Network Marketing playbook")).toBeTruthy();
    expect(screen.getByText(/Relationship goal: NETWORK-ONLY-GOAL/)).toBeTruthy();
    expect(screen.getByText(/rule characters loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "About the Network Marketing playbook" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Optional instruction" })).toBeTruthy();
    await user.type(screen.getByLabelText("Optional instruction"), "Reply naturally using the selected playbook.");
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    expect(await screen.findByDisplayValue("Network draft one")).toBeTruthy();
    expect(screen.getByText(/independently reviewed against the full Network Marketing rulebook/)).toBeTruthy();
    const networkRequest = JSON.parse(request.mock.calls.filter(([path]) => path === "/api/drafts")[0][1]?.body as string);
    expect(networkRequest.playbook.role).toBe("Network Marketing");
    expect(networkRequest.playbook.relationshipGoal).toBe("NETWORK-ONLY-GOAL");
    expect(networkRequest.playbook.rulebookFull).toContain("NETWORK-ONLY-RULES");
    expect(networkRequest.playbook.rulebookDigest).toBe("- Always answer the newest message.\n- Never invent facts.");
    expect(JSON.stringify(networkRequest)).not.toContain("HR-ONLY-GOAL");

    await user.selectOptions(inboxRole, "Human Resource");
    expect(screen.queryByLabelText("Edit draft 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    expect(await screen.findByDisplayValue("HR draft one")).toBeTruthy();
    const hrRequest = JSON.parse(request.mock.calls.filter(([path]) => path === "/api/drafts")[1][1]?.body as string);
    expect(hrRequest.playbook.role).toBe("Human Resource");
    expect(hrRequest.playbook.relationshipGoal).toBe("HR-ONLY-GOAL");
    expect(hrRequest.playbook.rulebookFull).toBe("HR-ONLY-RULES");
    expect(JSON.stringify(hrRequest)).not.toContain("NETWORK-ONLY-GOAL");
    expect(request.mock.calls.filter(([path]) => path === "/api/drafts")).toHaveLength(2);

    await waitFor(() => expect(document.querySelector(".save-state")?.textContent).toContain("Encrypted"), { timeout: 3_000 });
    firstRender.unmount();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(within(screen.getByRole("region", { name: "Reply to Taylor Lee" })).getByText("Advanced"));
    expect((screen.getByLabelText("Your role or team") as HTMLSelectElement).value).toBe("Human Resource");
  }, 30_000);

  it("keeps the Cloudflare Access session and shows its safe inline HTML-response error", async () => {
    const request = vi.fn().mockResolvedValue(new Response("<!doctype html><title>Sign in</title>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByLabelText(/Cloud access code/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    await user.type(screen.getByLabelText("Optional instruction"), "Write a short reply.");
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Draft was not generated.*Cloudflare sign-in session could not be verified/);
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
