// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { DraftProgressPanel } from "../src/components/DraftProgressPanel";
import { createDeviceVault, resetVaultForTests } from "../src/lib/secureVault";
import { createEmptyWorkspace } from "../src/lib/workspaceTypes";

vi.mock("@/lib/localOcr", () => ({
  captureVisibleScreen: vi.fn().mockResolvedValue(new Blob(["screen"])),
  cropImageToRegion: vi.fn().mockImplementation(async (image: Blob) => image),
  extractTextFromImage: vi.fn().mockResolvedValue("Taylor Lee\nWhat matters most right now?"),
}));

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const totals = {
  uncachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedNeurons: 0,
};

function usageResponse(): Response {
  return new Response(JSON.stringify({
    periodStart: "2026-08-01T00:00:00.000Z",
    nextResetAt: "2026-09-01T00:00:00.000Z",
    providers: {
      anthropic: {
        provider: "anthropic",
        consumedMicroUsd: 0,
        allowanceMicroUsd: 10_000_000,
        remainingMicroUsd: 10_000_000,
        quality: "unavailable",
        totals,
        models: [],
      },
      workersAi: {
        provider: "workers_ai",
        consumedMicroUsd: 0,
        allowanceMicroUsd: 2_000_000,
        remainingMicroUsd: 2_000_000,
        quality: "unavailable",
        totals,
        models: [],
      },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function learningStatusResponse(): Response {
  return new Response(JSON.stringify({
    enabled: true,
    noticeVersion: "2026-08-09-v1",
    retentionDays: 365,
    counts: { classifier: 0, evaluation: 0, generative: 0 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

type DraftReply = {
  draft: string;
  provider: "anthropic" | "cloudflare";
  model: string;
  mode: "stage-aware-single-draft-v1";
  requestId: string;
  usageAccounting: "recorded" | "pending";
  fallbackReason: null
    | "anthropic-allowance-exhausted"
    | "anthropic-accounting-unavailable"
    | "anthropic-pipeline-failed"
    | "provider-override";
};

function installRequest(draftReply: DraftReply | Response = {
  draft: "Which priority would be most useful to explore first?",
  provider: "anthropic",
  model: "claude-opus-4-6",
  mode: "stage-aware-single-draft-v1",
  requestId,
  usageAccounting: "recorded",
  fallbackReason: null,
}) {
  const request = vi.fn(async (...[input]: [RequestInfo | URL, RequestInit?]) => {
    const path = String(input);
    if (path === "/api/usage") return usageResponse();
    if (path === "/api/learning/status") return learningStatusResponse();
    if (path === "/api/drafts") {
      return draftReply instanceof Response
        ? draftReply
        : new Response(JSON.stringify(draftReply), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", request);
  return request;
}

async function seedDraftingWorkspace(configure?: (workspace: ReturnType<typeof createEmptyWorkspace>) => void) {
  const workspace = createEmptyWorkspace();
  workspace.cloudInference.consentedAt = "2026-08-09T00:00:00.000Z";
  workspace.inboxRole = "Network Marketing";
  workspace.guidance.selectedRole = "Network Marketing";
  workspace.contacts = [{
    id: "contact-1",
    name: "Taylor Lee",
    headline: "Community builder",
    company: "Example Co",
    profileNotes: "",
    platform: "linkedin",
    platformUrl: "",
    chat: [{
      id: "message-1",
      role: "them",
      speaker: "Taylor Lee",
      body: "What matters most when you decide which opportunity to explore?",
      createdAt: "2026-08-09T00:00:00.000Z",
      attachments: [],
    }],
    documents: [],
    outcomes: [],
    retentionDays: 90,
    profileUrl: "https://www.linkedin.com/in/taylor-lee/",
    avatarUrl: "",
    conversationUrl: "https://www.linkedin.com/messaging/thread/taylor-lee/",
    labels: [],
    pipelineStage: "inbox",
    notes: "",
    snoozedUntil: "",
    followUpAt: "",
    archivedAt: "",
    lastSyncedAt: "2026-08-09T00:00:00.000Z",
    relationshipStage: "learn_interests",
    conversationGoal: "Learn their current priorities",
    draftHistory: [],
  }];
  configure?.(workspace);
  await createDeviceVault(workspace);
}

function addSecondDraftingContact(workspace: ReturnType<typeof createEmptyWorkspace>) {
  workspace.contacts.push({
    ...workspace.contacts[0],
    id: "contact-2",
    name: "Jordan Kim",
    profileUrl: "https://www.linkedin.com/in/jordan-kim/",
    conversationUrl: "https://www.linkedin.com/messaging/thread/jordan-kim/",
    chat: [{
      ...workspace.contacts[0].chat[0],
      id: "message-2",
      speaker: "Jordan Kim",
      body: "What would you like to discuss?",
    }],
    draftHistory: [],
  });
}

beforeEach(async () => {
  await resetVaultForTests();
  localStorage.clear();
  await seedDraftingWorkspace();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(async () => {
  cleanup();
  await resetVaultForTests();
  vi.unstubAllGlobals();
});

describe("compact drafting interface", () => {
  it("renders only the compact summary, optional instruction, and generate controls by default", async () => {
    installRequest();
    render(<ChatHelpApp />);

    expect(await screen.findByRole("heading", { name: "Reply to Taylor Lee" })).toBeTruthy();
    expect(screen.getByText("Review and send manually")).toBeTruthy();
    expect(screen.getByText("Network Marketing / Learn interests / Claude primary")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Optional instruction" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate Precise Draft" })).toBeTruthy();
    const advanced = screen.getByText("Advanced");
    expect(advanced.parentElement?.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("combobox", { name: "Your role or team" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Conversation goal" })).toBeNull();
  });

  it("preserves every controlled Advanced value through keyboard collapse and generation", async () => {
    const request = installRequest();
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: "Reply to Taylor Lee" });

    const advanced = screen.getByText("Advanced");
    expect(advanced.tagName).toBe("SUMMARY");
    advanced.focus();
    expect(document.activeElement).toBe(advanced);
    await user.click(advanced);
    expect(advanced.parentElement?.hasAttribute("open")).toBe(true);
    await user.selectOptions(screen.getByRole("combobox", { name: "Your role or team" }), "Human Resource");
    await user.selectOptions(screen.getByRole("combobox", { name: "Relationship stage" }), "ask_permission");
    const goal = screen.getByRole("textbox", { name: "Conversation goal" });
    await user.clear(goal);
    await user.type(goal, "Ask permission to share one relevant idea");
    await user.type(screen.getByRole("textbox", { name: "Optional instruction" }), "Keep it concise and warm.");

    await user.click(advanced);
    expect(advanced.parentElement?.hasAttribute("open")).toBe(false);
    await user.click(advanced);
    expect((screen.getByRole("combobox", { name: "Your role or team" }) as HTMLSelectElement).value).toBe("Human Resource");
    expect((screen.getByRole("combobox", { name: "Relationship stage" }) as HTMLSelectElement).value).toBe("ask_permission");
    expect((screen.getByRole("textbox", { name: "Conversation goal" }) as HTMLTextAreaElement).value).toBe("Ask permission to share one relevant idea");

    await user.click(advanced);
    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    expect(await screen.findByLabelText("Edit draft 1")).toBeTruthy();
    const draftCall = request.mock.calls.find(([path]) => String(path) === "/api/drafts");
    const body = JSON.parse(draftCall?.[1]?.body as string);
    expect(body.playbook.role).toBe("Human Resource");
    expect(body.relationshipStage).toBe("ask_permission");
    expect(body.conversationGoal).toBe("Ask permission to share one relevant idea");
    expect(body.replyObjective).toBe("Keep it concise and warm.");
  }, 20_000);

  it("keeps normal progress collapsed and automatically opens truthful steps on error", async () => {
    installRequest(new Response(JSON.stringify({ error: "Cloudflare AI is temporarily unavailable." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: "Reply to Taylor Lee" });

    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cloudflare AI is temporarily unavailable.");
    const progressToggle = screen.getByRole("button", { name: "Hide AI steps" });
    expect(progressToggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Analyzing conversation stage").closest("li")?.dataset.status).toBe("error");
  }, 20_000);

  it("shows one fallback draft with exact provider metadata and direct learning actions", async () => {
    installRequest({
      draft: "Would it help to compare the priorities that matter most to you?",
      provider: "cloudflare",
      model: "@cf/meta/llama-3.1-8b-instruct-fast + @cf/openai/gpt-oss-120b",
      mode: "stage-aware-single-draft-v1",
      requestId,
      usageAccounting: "pending",
      fallbackReason: "anthropic-pipeline-failed",
    });
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: "Reply to Taylor Lee" });

    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    const card = await screen.findByRole("article", { name: "Completed draft" });
    expect(screen.getAllByLabelText("Edit draft 1")).toHaveLength(1);
    expect(within(card).getByText("Workers AI fallback")).toBeTruthy();
    expect(within(card).getByText("@cf/meta/llama-3.1-8b-instruct-fast + @cf/openai/gpt-oss-120b")).toBeTruthy();
    expect(within(card).getByText("Claude pipeline failed")).toBeTruthy();
    expect(within(card).getByText("Usage accounting pending")).toBeTruthy();
    expect(within(card).queryByText(/Claude Opus/i)).toBeNull();
    for (const name of ["Copy", "Useful", "Not useful"]) {
      expect(within(card).getByRole("button", { name })).toBeTruthy();
    }
    for (const name of ["Mark sent", "Save improvement", "More", "Dismiss draft 1", "Accept draft 1 as feedback", "Save edited draft 1 as feedback", "Reject draft 1 as feedback"]) {
      expect(within(card).queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Show AI steps" }).getAttribute("aria-expanded")).toBe("false");
  }, 20_000);

  it("discards an in-flight result after the user switches contacts", async () => {
    await resetVaultForTests();
    await seedDraftingWorkspace((workspace) => {
      addSecondDraftingContact(workspace);
    });
    let resolveDraft!: (response: Response) => void;
    const deferredDraft = new Promise<Response>((resolve) => { resolveDraft = resolve; });
    const request = vi.fn(async (...[input]: [RequestInfo | URL, RequestInit?]) => {
      const path = String(input);
      if (path === "/api/usage") return usageResponse();
      if (path === "/api/learning/status") return learningStatusResponse();
      if (path === "/api/drafts") return deferredDraft;
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: "Reply to Taylor Lee" });

    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    expect(screen.getByRole("button", { name: "Stop generating draft" })).toBeTruthy();
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Jordan Kim" }));
    expect(await screen.findByRole("heading", { name: "Reply to Jordan Kim" })).toBeTruthy();
    const usageCallsBeforeResolution = request.mock.calls.filter(([path]) => String(path) === "/api/usage").length;
    resolveDraft(new Response(JSON.stringify({
      draft: "Taylor's completed draft must not appear for Jordan.",
      provider: "anthropic",
      model: "claude-opus-4-6",
      mode: "stage-aware-single-draft-v1",
      requestId,
      usageAccounting: "recorded",
      fallbackReason: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path) === "/api/usage").length).toBeGreaterThan(usageCallsBeforeResolution));
    expect(screen.queryByLabelText("Edit draft 1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark sent" })).toBeNull();
    expect(screen.queryByText("Taylor's completed draft must not appear for Jordan.")).toBeNull();
  }, 20_000);

  it("discards an in-flight 503 after the user switches contacts", async () => {
    await resetVaultForTests();
    await seedDraftingWorkspace(addSecondDraftingContact);
    let resolveDraft!: (response: Response) => void;
    const deferredDraft = new Promise<Response>((resolve) => { resolveDraft = resolve; });
    const request = vi.fn(async (...[input]: [RequestInfo | URL, RequestInit?]) => {
      const path = String(input);
      if (path === "/api/usage") return usageResponse();
      if (path === "/api/learning/status") return learningStatusResponse();
      if (path === "/api/drafts") return deferredDraft;
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: "Reply to Taylor Lee" });

    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Jordan Kim" }));
    expect(await screen.findByRole("heading", { name: "Reply to Jordan Kim" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Generate Precise Draft" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop generating draft" })).toBeNull();

    const usageCallsBeforeResolution = request.mock.calls.filter(([path]) => String(path) === "/api/usage").length;
    resolveDraft(new Response(JSON.stringify({ error: "Taylor request failed after the switch." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path) === "/api/usage").length).toBeGreaterThan(usageCallsBeforeResolution));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Taylor request failed after the switch.")).toBeNull();
    expect(screen.queryByRole("button", { name: /AI steps/ })).toBeNull();
  }, 20_000);

  it("ignores streamed progress and error events after the user switches contacts", async () => {
    await resetVaultForTests();
    await seedDraftingWorkspace(addSecondDraftingContact);
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const request = vi.fn(async (...[input]: [RequestInfo | URL, RequestInit?]) => {
      const path = String(input);
      if (path === "/api/usage") return usageResponse();
      if (path === "/api/learning/status") return learningStatusResponse();
      if (path === "/api/drafts") return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: "Reply to Taylor Lee" });

    await user.click(screen.getByRole("button", { name: "Generate Precise Draft" }));
    await user.click(within(screen.getByRole("navigation", { name: "Conversations" })).getByRole("button", { name: "Open conversation with Jordan Kim" }));
    expect(await screen.findByRole("heading", { name: "Reply to Jordan Kim" })).toBeTruthy();
    const usageCallsBeforeResolution = request.mock.calls.filter(([path]) => String(path) === "/api/usage").length;
    const encoder = new TextEncoder();
    streamController.enqueue(encoder.encode('event: stage\ndata: {"stage":"drafting","status":"in-progress"}\n\n'));
    streamController.enqueue(encoder.encode('event: error\ndata: {"error":"Taylor stream failed after the switch."}\n\n'));
    streamController.close();

    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path) === "/api/usage").length).toBeGreaterThan(usageCallsBeforeResolution));
    expect(screen.getByRole("button", { name: "Generate Precise Draft" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Taylor stream failed after the switch.")).toBeNull();
    expect(screen.queryByRole("button", { name: /AI steps/ })).toBeNull();
  }, 20_000);

  it("does not infer fallback or accounting metadata for restored draft history", async () => {
    await resetVaultForTests();
    await seedDraftingWorkspace((workspace) => {
      workspace.contacts[0].draftHistory = [{
        id: "restored-workers-draft",
        agenda: "",
        drafts: ["A restored Workers AI draft."],
        createdAt: "2026-08-09T00:01:00.000Z",
        role: "Network Marketing",
        provider: "cloudflare",
        modelId: "@cf/meta/llama-3.1-8b-instruct-fast + @cf/openai/gpt-oss-120b",
      }];
    });
    installRequest();
    render(<ChatHelpApp />);

    const card = (await screen.findByLabelText("Edit draft 1")).closest("article");
    expect(card).toBeTruthy();
    expect(within(card as HTMLElement).getByText("Workers AI")).toBeTruthy();
    expect(within(card as HTMLElement).queryByText("Workers AI fallback")).toBeNull();
    expect(within(card as HTMLElement).queryByText("Routing")).toBeNull();
    expect(within(card as HTMLElement).queryByText("Usage")).toBeNull();
  });

  it("assigns unique controls and hides collapsed progress content from assistive technology", () => {
    const statuses = { analyzing: "pending", drafting: "pending", reviewing: "pending", finalizing: "pending" } as const;
    render(<>
      <DraftProgressPanel expanded={false} onToggle={() => undefined} role="Human Resource" ruleCharacters={120} statuses={statuses} />
      <DraftProgressPanel expanded={false} onToggle={() => undefined} role="Network Marketing" ruleCharacters={240} statuses={statuses} />
    </>);

    const controls = screen.getAllByRole("button", { name: "Show AI steps" }).map((button) => button.getAttribute("aria-controls"));
    expect(new Set(controls).size).toBe(2);
    for (const id of controls) {
      expect(id).toBeTruthy();
      expect(document.getElementById(id ?? "")?.hidden).toBe(true);
    }
  });
});
