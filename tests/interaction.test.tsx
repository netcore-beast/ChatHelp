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

    await user.click(screen.getByText("Draft context"));
    const draftContext = screen.getByRole("region", { name: "Draft context" });
    expect(within(draftContext).getByText(/Socializing\/Networking playbook/)).toBeTruthy();
    expect(within(draftContext).getByText("1 conversation message included")).toBeTruthy();
    expect(within(draftContext).getByText(/reply-rule characters/)).toBeTruthy();
    expect(within(draftContext).getByText("No optional objective")).toBeTruthy();
    expect(within(draftContext).getByText(/Could you share the role brief\?/)).toBeTruthy();
  });

  it("generates exactly one editable precise draft with stage, goal, and personal guidance", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      draft: "I can share the brief here. Which part would be most useful to start with?",
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "stage-aware-single-draft-v1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
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
    expect((screen.getByLabelText("What should your reply accomplish?") as HTMLTextAreaElement).value).toBe("");
    await user.selectOptions(screen.getByRole("combobox", { name: "Relationship stage" }), "learn_interests");
    await user.type(screen.getByRole("textbox", { name: "Conversation goal" }), "Learn which role detail matters most.");
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));

    expect(await screen.findByLabelText("Edit draft 1")).toBeTruthy();
    expect(screen.queryByLabelText("Edit draft 2")).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.credentials).toBe("same-origin");
    const requestBody = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(requestBody.replyObjective).toBe("");
    expect(requestBody.conversationContext).toContain("Could you share the role brief?");
    expect(requestBody.playbook.rulebookFull).toBeTruthy();
    expect(requestBody.playbook.rulebookDigest).toBeTruthy();
    expect(requestBody.personalGuidelines).toBe("Prefer plain language and one useful question.");
    expect(requestBody.relationshipStage).toBe("learn_interests");
    expect(requestBody.conversationGoal).toBe("Learn which role detail matters most.");
    expect(requestBody.latestMeaningfulIncoming).toMatchObject({ sender: "CONTACT", text: "Could you share the role brief?" });
    expect(screen.getByText(/Generated one precise draft with Claude Opus 4.6/i)).toBeTruthy();
    expect(screen.getByText("Finalizing precise draft").closest("li")?.dataset.status).toBe("done");
    expect(screen.getByRole("link", { name: /Open LinkedIn to review and paste/ })).toBeTruthy();
  }, 20_000);

  it("keeps personal learning off until opt-in and requires independent authorship before retrieval", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      draft: "I can share the brief. Which part would be most useful to explore first?",
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "stage-aware-single-draft-v1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await announceExtension();
    await deliverSnapshot();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const learningToggle = screen.getByRole("checkbox", { name: "Enable encrypted personal learning" }) as HTMLInputElement;
    expect(learningToggle.checked).toBe(false);
    expect(screen.getByText(/retrieval uses your approved examples as context and does not retrain any model/i)).toBeTruthy();
    await user.click(learningToggle);
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    const generated = await screen.findByLabelText("Edit draft 1") as HTMLTextAreaElement;
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).not.toHaveProperty("learningExamples");

    await user.clear(generated);
    await user.type(generated, "What part of the role would help you decide whether it is relevant?");
    await user.click(screen.getByRole("button", { name: "Save edited draft 1 as feedback" }));
    expect((await screen.findAllByText(/Saved encrypted feedback locally/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Provider-assisted by default")).toBeTruthy();
    const eligibility = screen.getByRole("checkbox", { name: "Use this response as a learning example" }) as HTMLInputElement;
    expect(eligibility.checked).toBe(false);
    expect(eligibility.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "I independently authored or have rights to this response" }));
    expect(eligibility.disabled).toBe(false);
    await user.click(eligibility);
    expect(eligibility.checked).toBe(true);
    await user.clear(screen.getByRole("textbox", { name: "Preferred response for learning" }));
    await user.type(screen.getByRole("textbox", { name: "Preferred response for learning" }), "Which detail would be most useful to understand first?");
    await user.click(screen.getByRole("button", { name: "Delete learning example" }));
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

  it("previews and downloads approved training exports without a LoRA upload action", async () => {
    const workspace = createEmptyWorkspace();
    workspace.stageTrainingRecords = [{
      id: "confirmed-stage",
      featureSchemaVersion: 1,
      role: "Network Marketing",
      messageCountBucket: "medium",
      hasIncomingQuestion: true,
      hasNeedSignal: true,
      hasPermissionSignal: false,
      hasValueDiscussionSignal: false,
      hasNextStepSignal: false,
      semanticTokens: ["career"],
      confirmedStage: "learn_interests",
      humanConfirmed: true,
      createdAt: "2026-08-01T00:00:00.000Z",
    }];
    workspace.feedback = [{
      id: "approved-response",
      contactId: "contact-a",
      role: "Network Marketing",
      relationshipStage: "learn_interests",
      conversationGoal: "Learn priorities",
      provider: "local",
      modelId: "independent-user-example",
      action: "edited",
      draft: "",
      preferredResponse: "Which priority would be most useful to explore?",
      outcome: "",
      reason: "",
      origin: "independently_user_authored",
      independentlyAuthoredAttested: true,
      eligibleForRetrieval: true,
      enabled: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }];
    await createDeviceVault(workspace);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("1 classifier confirmations")).toBeTruthy();
    expect(screen.getByText("1 independently authored generative examples")).toBeTruthy();
    expect(screen.getByText(/Cloudflare adapter upload is disabled in this release/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Download training manifest" }));
    await user.click(screen.getByRole("button", { name: "Download classifier JSONL" }));
    await user.click(screen.getByRole("button", { name: "Download independently authored generative JSONL" }));
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

    const objective = screen.getByRole("textbox", { name: "What should your reply accomplish?" });
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
    streamController?.enqueue(encoder.encode('event: stage\ndata: {"stage":"drafting","status":"done"}\n\nevent: stage\ndata: {"stage":"reviewing","status":"in-progress"}\n\nevent: stage\ndata: {"stage":"reviewing","status":"done"}\n\nevent: stage\ndata: {"stage":"finalizing","status":"in-progress"}\n\nevent: stage\ndata: {"stage":"finalizing","status":"done"}\n\nevent: result\ndata: {"draft":"One precise reply","provider":"anthropic","model":"claude-opus-4-6","mode":"stage-aware-single-draft-v1"}\n\n'));
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
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        draft: "Network draft one",
        provider: "cloudflare",
        model: "@cf/meta/llama-3.1-8b-instruct-fast + @cf/openai/gpt-oss-120b",
        mode: "stage-aware-single-draft-v1",
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        draft: "HR draft one",
        provider: "anthropic",
        model: "claude-opus-4-6",
        mode: "stage-aware-single-draft-v1",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
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
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
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
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
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
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.queryByLabelText(/Cloud access code/)).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /I understand that relevant visible conversation text/ }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Taylor Lee" }));
    await user.type(screen.getByLabelText("What should your reply accomplish?"), "Write a short reply.");
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
