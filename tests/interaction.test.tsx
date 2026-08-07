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

async function announceExtension() {
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
    expect(screen.queryByRole("complementary", { name: "Workspace navigation" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Workspace view" })).toBeTruthy();
    expect(screen.getByLabelText("Conversation inbox")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "settings");
    await user.type(screen.getByLabelText("New contact name"), "Alex Morgan");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "inbox");
    expect(await within(screen.getByRole("navigation", { name: "Conversations" })).findByRole("button", { name: "Open conversation with Alex Morgan" })).toBeTruthy();
    expect(screen.getByLabelText("Conversation with Alex Morgan")).toBeTruthy();
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

    await user.click(screen.getByText("Draft context"));
    const draftContext = screen.getByRole("region", { name: "Draft context" });
    expect(within(draftContext).getByText(/Socializing\/Networking playbook/)).toBeTruthy();
    expect(within(draftContext).getByText("1 conversation message included")).toBeTruthy();
    expect(within(draftContext).getByText(/reply-rule characters/)).toBeTruthy();
    expect(within(draftContext).getByText("No optional objective")).toBeTruthy();
    expect(within(draftContext).getByText(/Could you share the role brief\?/)).toBeTruthy();
  });

  it("generates exactly three editable drafts for a newly synchronized contact", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      drafts: ["I can share the brief here.", "Happy to send the details—what would be most useful?", "I’ll send a concise overview for you to review."],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();
    expect(await screen.findByLabelText("Conversation with Taylor Lee")).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "settings");
    expect(screen.queryByLabelText(/Cloud access code/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "inbox");
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    expect((screen.getByLabelText("What should your reply accomplish?") as HTMLTextAreaElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Generate 3 Drafts" }));

    expect(await screen.findByLabelText("Edit draft 1")).toBeTruthy();
    expect(screen.getByLabelText("Edit draft 2")).toBeTruthy();
    expect(screen.getByLabelText("Edit draft 3")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.credentials).toBe("same-origin");
    const requestBody = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(requestBody.replyObjective).toBe("");
    expect(requestBody.conversationContext).toContain("Could you share the role brief?");
    expect(requestBody.playbook.rulebookFull).toBeTruthy();
    expect(requestBody.playbook.rulebookDigest).toBeTruthy();
    expect(screen.getByText(/independently reviewed against the full Socializing\/Networking rulebook/i)).toBeTruthy();
    expect(screen.getByText("Finalizing drafts").closest("li")?.dataset.status).toBe("done");
    expect(screen.getByRole("link", { name: /Open LinkedIn to review and paste/ })).toBeTruthy();
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "settings");
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "inbox");
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));

    const objective = screen.getByRole("textbox", { name: "What should your reply accomplish?" });
    const promptComposer = objective.closest(".prompt-composer");
    expect(promptComposer).toBeTruthy();
    expect(within(promptComposer as HTMLElement).getByRole("button", { name: "Generate 3 Drafts" })).toBeTruthy();
    expect(promptComposer?.querySelector(".prompt-composer-actions")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Generate 3 Drafts" }));
    const stopButton = screen.getByRole("button", { name: "Stop generating drafts" });
    expect((stopButton as HTMLButtonElement).disabled).toBe(false);
    expect(stopButton.getAttribute("aria-busy")).toBe("true");
    expect(stopButton.querySelector(".draft-button-spinner")).toBeTruthy();
    expect(stopButton.querySelector(".draft-stop-symbol")).toBeTruthy();
    expect(stopButton.textContent).not.toContain("Generating");
    const progressToggle = screen.getByRole("button", { name: "Show AI steps" });
    expect(progressToggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(progressToggle);
    expect(progressToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Planning reply with Llama 3.1 8B")).toBeTruthy();

    streamController?.enqueue(encoder.encode('event: stage\ndata: {"stage":"planning","status":"in-progress"}\n\n'));
    streamController?.enqueue(encoder.encode('event: stage\ndata: {"stage":"planning","status":"done"}\n\nevent: stage\ndata: {"stage":"drafting","status":"in-progress"}\n\n'));
    await waitFor(() => expect(screen.getByText("Drafting 3 replies with GPT-OSS 120B").closest("li")?.dataset.status).toBe("in-progress"));
    streamController?.enqueue(encoder.encode('event: stage\ndata: {"stage":"drafting","status":"done"}\n\nevent: stage\ndata: {"stage":"reviewing","status":"in-progress"}\n\nevent: stage\ndata: {"stage":"reviewing","status":"done"}\n\nevent: stage\ndata: {"stage":"finalizing","status":"in-progress"}\n\nevent: stage\ndata: {"stage":"finalizing","status":"done"}\n\nevent: result\ndata: {"drafts":["One","Two","Three"]}\n\n'));
    streamController?.close();

    expect((await screen.findByRole("button", { name: "Generate 3 Drafts" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Hide AI steps" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Finalizing drafts").closest("li")?.dataset.status).toBe("done");
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "settings");
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "inbox");
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));

    await user.click(screen.getByRole("button", { name: "Generate 3 Drafts" }));
    const stopButton = screen.getByRole("button", { name: "Stop generating drafts" });
    expect(stopButton.textContent).not.toContain("Generating");
    await user.click(stopButton);

    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(await screen.findByRole("button", { name: "Generate 3 Drafts" })).toBeTruthy();
    expect(screen.queryByText("Drafts were not generated.")).toBeNull();
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "settings");
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
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ drafts: ["Network draft one", "Network draft two", "Network draft three"] }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ drafts: ["HR draft one", "HR draft two", "HR draft three"] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const firstRender = render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await announceExtension();
    await deliverSnapshot();

    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "settings");
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

    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "inbox");
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
    expect(screen.getByRole("button", { name: "About the optional reply objective" })).toBeTruthy();
    await user.type(screen.getByLabelText("What should your reply accomplish?"), "Reply naturally using the selected playbook.");
    await user.click(screen.getByRole("button", { name: "Generate 3 Drafts" }));
    expect(await screen.findByDisplayValue("Network draft one")).toBeTruthy();
    expect(screen.getByText(/independently reviewed against the full Network Marketing rulebook/)).toBeTruthy();
    const networkRequest = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(networkRequest.playbook.role).toBe("Network Marketing");
    expect(networkRequest.playbook.relationshipGoal).toBe("NETWORK-ONLY-GOAL");
    expect(networkRequest.playbook.rulebookFull).toContain("NETWORK-ONLY-RULES");
    expect(networkRequest.playbook.rulebookDigest).toBe("- Always answer the newest message.\n- Never invent facts.");
    expect(JSON.stringify(networkRequest)).not.toContain("HR-ONLY-GOAL");

    await user.selectOptions(inboxRole, "Human Resource");
    expect(screen.queryByLabelText("Edit draft 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Generate 3 Drafts" }));
    expect(await screen.findByDisplayValue("HR draft one")).toBeTruthy();
    const hrRequest = JSON.parse(request.mock.calls[1][1]?.body as string);
    expect(hrRequest.playbook.role).toBe("Human Resource");
    expect(hrRequest.playbook.relationshipGoal).toBe("HR-ONLY-GOAL");
    expect(hrRequest.playbook.rulebookFull).toBe("HR-ONLY-RULES");
    expect(JSON.stringify(hrRequest)).not.toContain("NETWORK-ONLY-GOAL");
    expect(request).toHaveBeenCalledTimes(2);

    await waitFor(() => expect(document.querySelector(".save-state")?.textContent).toContain("Encrypted"), { timeout: 3_000 });
    firstRender.unmount();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
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
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "settings");
    expect(screen.queryByLabelText(/Cloud access code/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace view" }), "inbox");
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    await user.type(screen.getByLabelText("What should your reply accomplish?"), "Write a short reply.");
    await user.click(screen.getByRole("button", { name: "Generate 3 Drafts" }));
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
