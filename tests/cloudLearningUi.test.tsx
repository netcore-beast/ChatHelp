// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { SaveImprovementDialog } from "../src/components/SaveImprovementDialog";
import { UsageSettingsCard } from "../src/components/UsageSettingsCard";
import type { CloudUsageSummary } from "../src/lib/cloudUsage";
import { createDeviceVault, openDeviceVault, resetVaultForTests } from "../src/lib/secureVault";
import { createEmptyWorkspace } from "../src/lib/workspaceTypes";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const providerDraft = "Thanks, Taylor at Example Co. I can share the role brief here.";

async function renderCompletedDraft(options: { secondContact?: boolean } = {}) {
  const workspace = createEmptyWorkspace();
  workspace.inboxRole = "Human Resource";
  workspace.contacts = [{
    id: "learning-ui-contact",
    name: "Taylor Lee",
    headline: "Talent Partner",
    company: "Example Co",
    profileNotes: "",
    profileUrl: "https://www.linkedin.com/in/taylor-lee/",
    platform: "linkedin",
    platformUrl: "https://www.linkedin.com/messaging/thread/taylor-lee/",
    relationshipStage: "learn_interests",
    conversationGoal: "Learn which role detail matters most.",
    chat: [{ id: "incoming", role: "them", body: "Could you share the role brief?", createdAt: "2026-08-09T11:00:00.000Z" }],
    documents: [],
    outcomes: [],
    retentionDays: 90,
    draftHistory: [{
      id: "completed-draft-set",
      agenda: "",
      drafts: [providerDraft],
      createdAt: "2026-08-09T12:00:00.000Z",
      role: "Human Resource",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    }],
  }];
  if (options.secondContact) workspace.contacts.push({
    id: "learning-ui-second-contact",
    name: "Morgan Chen",
    headline: "Security Lead",
    company: "Northwind",
    profileNotes: "",
    profileUrl: "https://www.linkedin.com/in/morgan-chen/",
    platform: "linkedin",
    platformUrl: "https://www.linkedin.com/messaging/thread/morgan-chen/",
    relationshipStage: "genuine_rapport",
    conversationGoal: "Build genuine rapport.",
    chat: [{ id: "second-incoming", role: "them", body: "Good to meet you.", createdAt: "2026-08-09T11:05:00.000Z" }],
    documents: [],
    outcomes: [],
    retentionDays: 90,
    draftHistory: [{ id: "second-draft-set", agenda: "", drafts: ["Good to meet you too."], createdAt: "2026-08-09T12:05:00.000Z", role: "Human Resource" }],
  });
  await createDeviceVault(workspace);
  render(<ChatHelpApp />);
  await screen.findByRole("heading", { name: /private conversation studio/i });
  return userEvent.setup();
}

async function openIndependentPath() {
  const user = await renderCompletedDraft();
  await user.click(screen.getByRole("button", { name: "Save improvement" }));
  await user.click(screen.getByRole("button", { name: "Add my own version" }));
  return user;
}

beforeEach(async () => {
  await resetVaultForTests();
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await resetVaultForTests();
  vi.unstubAllGlobals();
});

describe("approved draft improvement workflow", () => {
  it("opens two explicit learning paths from Save improvement", async () => {
    const user = await renderCompletedDraft();

    await user.click(screen.getByRole("button", { name: "Save improvement" }));

    expect(screen.getByRole("heading", { name: "Help improve future drafts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rate this draft" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add my own version" })).toBeTruthy();
  });

  it("never prefills the provider draft into the independent editor", async () => {
    await openIndependentPath();

    expect((screen.getByRole("textbox", { name: "Your independently written response" }) as HTMLTextAreaElement).value).toBe("");
    expect(within(screen.getByRole("dialog", { name: "Help improve future drafts" })).queryByText(providerDraft)).toBeNull();
  });

  it("requires rights and exact sanitized-preview attestations", async () => {
    const user = await openIndependentPath();
    const editor = screen.getByRole("textbox", { name: "Your independently written response" });
    await user.type(editor, "Thanks Taylor Lee, what part of Sentinel interests you most?");

    const save = screen.getByRole("button", { name: "Save approved example" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }));
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it("invalidates privacy approval when known identifiers change the exact preview", async () => {
    const user = userEvent.setup();
    const callbacks = { onClose: vi.fn(), onRate: vi.fn(), onSaveIndependent: vi.fn() };
    const { rerender } = render(<SaveImprovementDialog
      knownIdentifiers={{ contactName: "Taylor Lee", company: "Example Co", profileUrl: "", profileHandle: "" }}
      {...callbacks}
    />);
    await user.click(screen.getByRole("button", { name: "Add my own version" }));
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "Thanks Taylor Lee at Example Co, which detail matters most?");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    const privacy = screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }) as HTMLInputElement;
    await user.click(privacy);
    expect((screen.getByRole("button", { name: "Save approved example" }) as HTMLButtonElement).disabled).toBe(false);

    rerender(<SaveImprovementDialog
      knownIdentifiers={{ contactName: "Jordan Park", company: "Contoso", profileUrl: "", profileHandle: "" }}
      {...callbacks}
    />);

    expect(privacy.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save approved example" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the exact sanitized preview and resets privacy approval when it changes", async () => {
    const user = await openIndependentPath();
    const editor = screen.getByRole("textbox", { name: "Your independently written response" });
    await user.type(editor, "Thanks Taylor Lee at Example Co, which detail matters most?");

    expect((screen.getByRole("status", { name: "Sanitized preview" }) as HTMLOutputElement).value).toBe("Thanks [contact] at [company], which detail matters most?");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    const privacy = screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }) as HTMLInputElement;
    await user.click(privacy);
    expect(privacy.checked).toBe(true);

    await user.type(editor, " Please.");
    expect(privacy.checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save approved example" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rejects machine-detectable identifiers before an independent example can be saved", async () => {
    const user = await openIndependentPath();
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "Please email me at example@example.com");

    expect(screen.getByRole("alert").textContent).toContain("Remove the email address before saving.");
    expect(screen.queryByRole("status", { name: "Sanitized preview" })).toBeNull();
    expect((screen.getByRole("button", { name: "Save approved example" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uploads a text-free evaluation record when the user rates the draft", async () => {
    const request = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const recordId = JSON.parse(init?.body as string).records[0].recordId;
      return new Response(JSON.stringify({ accepted: [{ recordId, contentDigest: "a".repeat(64) }], duplicates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);
    const user = await renderCompletedDraft();

    await user.click(screen.getByRole("button", { name: "Save improvement" }));
    await user.click(screen.getByRole("button", { name: "Rate this draft" }));
    await user.click(screen.getByRole("button", { name: "Useful" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const body = JSON.parse(request.mock.calls[0][1]?.body as string);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].record).toEqual({
      recordKind: "evaluation",
      roleId: "human_resource",
      relationshipStage: "learn_interests",
      goalCategory: "discover_interests",
      provenance: "human_confirmed",
      evaluationAction: "useful",
    });
    expect(JSON.stringify(body.records[0].record)).not.toContain(providerDraft);
    expect(body.records[0].record).not.toHaveProperty("target");
  });

  it("uploads only the sanitized independent target and positive attestations", async () => {
    const request = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const recordId = JSON.parse(init?.body as string).records[0].recordId;
      return new Response(JSON.stringify({ accepted: [{ recordId, contentDigest: "b".repeat(64) }], duplicates: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);
    const user = await openIndependentPath();
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "Thanks Taylor Lee at Example Co, which detail matters most?");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }));

    await user.click(screen.getByRole("button", { name: "Save approved example" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const record = JSON.parse(request.mock.calls[0][1]?.body as string).records[0].record;
    expect(record).toEqual({
      recordKind: "generative",
      roleId: "human_resource",
      relationshipStage: "learn_interests",
      goalCategory: "discover_interests",
      provenance: "independently_user_authored",
      target: "Thanks [contact] at [company], which detail matters most?",
      rightsAttested: true,
      privacyAttested: true,
    });
    expect(record).not.toHaveProperty("rightsAttestedAt");
    expect(record).not.toHaveProperty("privacyAttestedAt");
    await waitFor(async () => {
      const saved = (await openDeviceVault()).workspace;
      expect(saved.pendingLearningRecords).toEqual([]);
      expect(saved.cloudLearningSync).toEqual([expect.objectContaining({ status: "synced", contentDigest: "b".repeat(64) })]);
      expect(saved.cloudLearningDeletionMarkers).toEqual([expect.objectContaining({ disposition: "acknowledged", sourceCollection: "feedback" })]);
    }, { timeout: 3_000 });
  });

  it("keeps a failed sanitized upload encrypted and reports pending sync without changing the draft", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const user = await openIndependentPath();
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "Thanks Taylor Lee at Example Co, which detail matters most?");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }));

    await user.click(screen.getByRole("button", { name: "Save approved example" }));

    expect(await screen.findByText("Cloud learning sync pending")).toBeTruthy();
    expect((screen.getByLabelText("Edit draft 1") as HTMLTextAreaElement).value).toBe(providerDraft);
    await waitFor(async () => expect((await openDeviceVault()).workspace.pendingLearningRecords).toEqual([
      expect.objectContaining({
        recordKind: "generative",
        sanitizedPayload: expect.objectContaining({ target: "Thanks [contact] at [company], which detail matters most?" }),
      }),
    ]), { timeout: 3_000 });
    const pending = (await openDeviceVault()).workspace.pendingLearningRecords;
    expect(JSON.stringify(pending)).not.toContain("Taylor Lee");
    expect(JSON.stringify(pending)).not.toContain("Example Co");
    expect(JSON.stringify(pending)).not.toContain(providerDraft);
  });

  it("retains a sanitized record when a successful response does not acknowledge it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: [], duplicates: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Save improvement" }));
    await user.click(screen.getByRole("button", { name: "Rate this draft" }));
    await user.click(screen.getByRole("button", { name: "Useful" }));

    expect(await screen.findByText("Cloud learning sync pending")).toBeTruthy();
    await waitFor(async () => expect((await openDeviceVault()).workspace.pendingLearningRecords).toEqual([
      expect.objectContaining({ recordKind: "evaluation", sanitizedPayload: expect.objectContaining({ evaluationAction: "useful" }) }),
    ]), { timeout: 3_000 });
  });

  it("keeps focus inside the modal while a deferred upload disables its submit control", async () => {
    let resolveRating!: () => void;
    const onRate = vi.fn(() => new Promise<void>((resolve) => { resolveRating = resolve; }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SaveImprovementDialog
      knownIdentifiers={{ contactName: "", company: "", profileUrl: "", profileHandle: "" }}
      onClose={onClose}
      onRate={onRate}
      onSaveIndependent={vi.fn()}
    />);
    await user.click(screen.getByRole("button", { name: "Rate this draft" }));
    await user.click(screen.getByRole("button", { name: "Useful" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close improvement dialog" }));
    resolveRating();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("does not overwrite a completed cloud-learning clear with a delayed upload status", async () => {
    let resolveUpload!: (response: Response) => void;
    let uploadRecordId = "";
    let uploadRequestCount = 0;
    const uploadResponse = new Promise<Response>((resolve) => { resolveUpload = resolve; });
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/learning/status" && init?.method === "GET") {
        return Promise.resolve(learningJson(enabledLearningStatus));
      }
      if (path === "/api/learning/records" && init?.method === "PUT") {
        uploadRequestCount += 1;
        uploadRecordId = JSON.parse(init.body as string).records[0].recordId;
        return uploadResponse;
      }
      if (path === "/api/learning" && init?.method === "DELETE") {
        return Promise.resolve(new Response(JSON.stringify({ enabled: false, deleted: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }));
    }));
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Save improvement" }));
    await user.click(screen.getByRole("button", { name: "Rate this draft" }));
    await user.click(screen.getByRole("button", { name: "Useful" }));
    await waitFor(() => expect(uploadRecordId).not.toBe(""));
    await user.click(screen.getByRole("button", { name: "Close improvement dialog" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Retry cloud learning sync" }));
    await waitFor(() => expect(uploadRequestCount).toBe(2));
    await user.click(screen.getByRole("button", { name: "Disable and delete cloud learning" }));
    expect(await screen.findByText("Cloud learning disabled and deleted")).toBeTruthy();

    await act(async () => {
      resolveUpload(new Response(JSON.stringify({ accepted: [{ recordId: uploadRecordId, contentDigest: "d".repeat(64) }], duplicates: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await Promise.resolve();
    });

    expect(screen.queryByText("Cloud learning sync complete")).toBeNull();
    expect(screen.getByText("Cloud learning disabled and deleted")).toBeTruthy();
    await waitFor(async () => {
      const saved = (await openDeviceVault()).workspace;
      expect(saved.pendingLearningRecords).toEqual([]);
      expect(saved.cloudLearningSync).toEqual([]);
    }, { timeout: 3_000 });
  }, 20_000);

  it("moves focus into the dialog and returns it to Save improvement after close", async () => {
    const user = await renderCompletedDraft();
    const opener = screen.getByRole("button", { name: "Save improvement" });

    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close improvement dialog" }));
    await user.click(screen.getByRole("button", { name: "Close improvement dialog" }));

    expect(document.activeElement).toBe(opener);
  });

  it("keeps focus inside the modal when switching between improvement paths", async () => {
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Save improvement" }));

    await user.click(screen.getByRole("button", { name: "Rate this draft" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Useful" }));

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rate this draft" }));

    await user.click(screen.getByRole("button", { name: "Add my own version" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Your independently written response" }));
  });

  it("closes the improvement dialog when the active contact changes", async () => {
    const user = await renderCompletedDraft({ secondContact: true });
    await user.click(screen.getByRole("button", { name: "Save improvement" }));
    await user.click(screen.getByRole("button", { name: "Add my own version" }));

    fireEvent.click(screen.getByRole("button", { name: "Open conversation with Morgan Chen" }));
    expect(screen.queryByRole("dialog", { name: "Help improve future drafts" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open conversation with Taylor Lee" }));
    expect(screen.queryByRole("dialog", { name: "Help improve future drafts" })).toBeNull();
  });

  it("closes on Escape and restores focus to the opener", async () => {
    const user = await renderCompletedDraft();
    const opener = screen.getByRole("button", { name: "Save improvement" });
    await user.click(opener);

    fireEvent.keyDown(screen.getByRole("button", { name: "Close improvement dialog" }), { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Help improve future drafts" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("contains Tab and Shift+Tab focus within the modal", async () => {
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Save improvement" }));
    const close = screen.getByRole("button", { name: "Close improvement dialog" });
    const last = screen.getByRole("button", { name: "Add my own version" });

    expect(document.activeElement).toBe(close);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(close);
  });
});

function learningJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

const enabledLearningStatus = {
  enabled: true,
  noticeVersion: "2026-08-09-v1",
  retentionDays: 365,
  counts: { classifier: 4, evaluation: 3, generative: 2 },
};

const usageTotals = {
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

const separatedUsageSummary: CloudUsageSummary = {
  periodStart: "2026-08-01T00:00:00.000Z",
  nextResetAt: "2026-09-01T00:00:00.000Z",
  providers: {
    anthropic: {
      provider: "anthropic",
      consumedMicroUsd: 2_500_000,
      allowanceMicroUsd: 12_000_000,
      remainingMicroUsd: 9_500_000,
      quality: "exact",
      totals: { ...usageTotals, uncachedInputTokens: 100, cacheWriteTokens: 30, cacheWrite5mTokens: 10, cacheWrite1hTokens: 20, cacheReadTokens: 40, outputTokens: 50, thinkingTokens: 5 },
      models: [{
        modelId: "claude-opus-4-6",
        consumedMicroUsd: 2_500_000,
        quality: "exact",
        totals: { ...usageTotals, uncachedInputTokens: 100, cacheWriteTokens: 30, cacheWrite5mTokens: 10, cacheWrite1hTokens: 20, cacheReadTokens: 40, outputTokens: 50, thinkingTokens: 5 },
      }],
    },
    workersAi: {
      provider: "workers_ai",
      consumedMicroUsd: 300_000,
      allowanceMicroUsd: 2_000_000,
      remainingMicroUsd: 1_700_000,
      quality: "estimated",
      totals: { ...usageTotals, uncachedInputTokens: 20, outputTokens: 20, promptTokens: 20, completionTokens: 20, totalTokens: 40 },
      models: [{
        modelId: "@cf/meta/llama-3.1-8b-instruct-fast",
        consumedMicroUsd: 100_000,
        quality: "estimated",
        totals: { ...usageTotals, uncachedInputTokens: 9, outputTokens: 7, promptTokens: 9, completionTokens: 7, totalTokens: 16 },
      }, {
        modelId: "@cf/openai/gpt-oss-120b",
        consumedMicroUsd: 200_000,
        quality: "exact",
        totals: { ...usageTotals, uncachedInputTokens: 11, outputTokens: 13, promptTokens: 11, completionTokens: 13, totalTokens: 24 },
      }],
    },
  },
};

const firstLearningCursor = Buffer.from(JSON.stringify({
  updatedAt: "2026-08-08T00:00:00.000Z",
  recordId: "evaluation-1",
})).toString("base64url");

function learningRecord(recordKind: "classifier" | "evaluation" | "generative", recordId: string) {
  const base = {
    recordId,
    recordKind,
    roleId: "network_marketing",
    relationshipStage: "learn_interests",
    goalCategory: "discover_interests",
    enabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2027-08-01T00:00:00.000Z",
  };
  if (recordKind === "generative") return { ...base, target: "Thanks [contact], what area interests you?" };
  if (recordKind === "evaluation") return { ...base, evaluationAction: "useful" };
  return { ...base, classifierFeatures: {
    messageCountBucket: "low",
    hasIncomingQuestion: false,
    hasNeedSignal: false,
    hasPermissionSignal: false,
    hasValueDiscussionSignal: false,
    hasNextStepSignal: false,
  } };
}

async function renderLearningSettings(
  fetchImplementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  options: { inferenceConsented?: boolean } = {},
) {
  const workspace = createEmptyWorkspace();
  if (options.inferenceConsented) workspace.cloudInference.consentedAt = "2026-08-09T12:00:00.000Z";
  await createDeviceVault(workspace);
  const request = vi.fn(fetchImplementation);
  vi.stubGlobal("fetch", request);
  const user = userEvent.setup();
  render(<ChatHelpApp />);
  await screen.findByRole("heading", { name: /private conversation studio/i });
  await user.click(screen.getByRole("button", { name: "Settings" }));
  return { request, user };
}

describe("per-provider usage settings", () => {
  it("loads signed-in-account usage whenever Settings opens", async () => {
    const { request } = await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") return learningJson(enabledLearningStatus);
      if (String(input) === "/api/usage") return learningJson(separatedUsageSummary);
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path) === "/api/usage")).toHaveLength(1));
  });

  it("shows separate app allowances without claiming provider credits", async () => {
    await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") return learningJson(enabledLearningStatus);
      if (String(input) === "/api/usage") return learningJson(separatedUsageSummary);
      throw new Error(`Unexpected request: ${String(input)}`);
    }, { inferenceConsented: true });

    const accountUsage = await screen.findByRole("region", { name: "This signed-in account" });
    expect(within(accountUsage).getByRole("heading", { name: "Anthropic" })).toBeTruthy();
    expect(within(accountUsage).getByRole("heading", { name: "Workers AI" })).toBeTruthy();
    expect(within(accountUsage).getByRole("article", { name: "Anthropic" })).toBeTruthy();
    expect(within(accountUsage).getByRole("article", { name: "Workers AI" })).toBeTruthy();
    expect(within(accountUsage).getByText("Configured monthly app allowances with consumed and estimated remaining amounts from DialogMint's recorded usage for this account.")).toBeTruthy();
    expect(within(accountUsage).getAllByText("Estimated remaining app allowance")).toHaveLength(2);
    expect(within(accountUsage).getByText("Resets Sep 1, 2026 at 12:00 AM UTC")).toBeTruthy();
    expect(within(accountUsage).queryByText(/credit balance|provider balance|prepaid credits|token balance|billing balance/i)).toBeNull();
  });

  it("marks mixed Workers accounting honestly and keeps model detail in a closed native disclosure", () => {
    render(<UsageSettingsCard summary={separatedUsageSummary} />);
    expect(within(screen.getByRole("region", { name: "This signed-in account" })).queryAllByRole("banner")).toHaveLength(0);
    const workersCard = screen.getByRole("heading", { name: "Workers AI" }).closest("article");
    expect(workersCard).not.toBeNull();
    const workers = within(workersCard as HTMLElement);

    expect(workers.getByText("Includes estimated usage")).toBeTruthy();
    expect(workers.getByText("Llama price uses published FP8-Fast proxy")).toBeTruthy();
    const totals = workers.getByLabelText("Workers AI token totals");
    expect(within(totals).getByText("Input tokens").parentElement?.textContent).toBe("Input tokens20");
    expect(within(totals).getByText("Output tokens").parentElement?.textContent).toBe("Output tokens20");
    expect(within(totals).getByText("Thinking tokens (included in output)")).toBeTruthy();

    const advancedSummary = workers.getByText("Advanced").closest("summary") as HTMLElement;
    const advanced = advancedSummary.closest("details") as HTMLDetailsElement;
    expect(advancedSummary.tagName).toBe("SUMMARY");
    expect(advancedSummary.getAttribute("aria-label")).toBe("Workers AI Advanced");
    expect(advanced.open).toBe(false);
    expect(within(advanced).getByText("@cf/meta/llama-3.1-8b-instruct-fast")).toBeTruthy();
    expect(within(advanced).getByText("@cf/openai/gpt-oss-120b")).toBeTruthy();
    advancedSummary.focus();
    expect(document.activeElement).toBe(advancedSummary);
    // JSDOM omits the native summary keyboard default; click models the UA activation after each uncanceled key sequence.
    expect(fireEvent.keyDown(advancedSummary, { key: "Enter", code: "Enter" })).toBe(true);
    fireEvent.click(advancedSummary);
    expect(advanced.open).toBe(true);
    expect(fireEvent.keyDown(advancedSummary, { key: " ", code: "Space" })).toBe(true);
    expect(fireEvent.keyUp(advancedSummary, { key: " ", code: "Space" })).toBe(true);
    fireEvent.click(advancedSummary);
    expect(advanced.open).toBe(false);
  });

  it("keys the FP8-Fast proxy disclosure to the Llama model instead of token quality", () => {
    const exactLlama = structuredClone(separatedUsageSummary);
    exactLlama.providers.workersAi.quality = "exact";
    exactLlama.providers.workersAi.models[0].quality = "exact";
    const { rerender } = render(<UsageSettingsCard summary={exactLlama} />);
    expect(screen.getByText("Llama price uses published FP8-Fast proxy")).toBeTruthy();

    const estimatedGpt = structuredClone(separatedUsageSummary);
    estimatedGpt.providers.workersAi.consumedMicroUsd = 200_000;
    estimatedGpt.providers.workersAi.remainingMicroUsd = 1_800_000;
    estimatedGpt.providers.workersAi.totals = { ...usageTotals, uncachedInputTokens: 11, outputTokens: 13, promptTokens: 11, completionTokens: 13, totalTokens: 24 };
    estimatedGpt.providers.workersAi.models = [{
      ...estimatedGpt.providers.workersAi.models[1],
      quality: "estimated",
    }];
    rerender(<UsageSettingsCard summary={estimatedGpt} />);
    expect(screen.queryByText("Llama price uses published FP8-Fast proxy")).toBeNull();
    expect(screen.getByText("Includes estimated usage")).toBeTruthy();
  });

  it("distinguishes loading, unavailable, and recorded-zero usage", () => {
    const { rerender } = render(<UsageSettingsCard summary={null} />);
    expect(screen.getByRole("status").textContent).toContain("Loading current app allowances");

    rerender(<UsageSettingsCard summary={null} statusMessage="App allowances are temporarily unavailable." />);
    expect(screen.getByRole("status").textContent).toBe("App allowances are temporarily unavailable.");
    expect(screen.queryByText(/Loading current app allowances/)).toBeNull();

    const unavailable = structuredClone(separatedUsageSummary);
    for (const provider of [unavailable.providers.anthropic, unavailable.providers.workersAi]) {
      provider.consumedMicroUsd = 0;
      provider.remainingMicroUsd = provider.allowanceMicroUsd;
      provider.quality = "unavailable";
      provider.totals = { ...usageTotals };
      provider.models = [];
    }
    rerender(<UsageSettingsCard summary={unavailable} />);
    expect(screen.getAllByText("Recorded usage quality unavailable")).toHaveLength(2);
    expect(screen.getAllByText("$0.00", { selector: "dd" })).toHaveLength(2);
    expect(screen.queryByText(/Loading current app allowances/)).toBeNull();
  });

  it("clamps over-allowance and zero-allowance progress without hiding consumed usage", () => {
    const overAllowance = structuredClone(separatedUsageSummary);
    overAllowance.providers.anthropic.consumedMicroUsd = 13_000_000;
    overAllowance.providers.anthropic.remainingMicroUsd = 0;
    overAllowance.providers.anthropic.models[0].consumedMicroUsd = 13_000_000;
    overAllowance.providers.workersAi.consumedMicroUsd = 100_000;
    overAllowance.providers.workersAi.allowanceMicroUsd = 0;
    overAllowance.providers.workersAi.remainingMicroUsd = 0;
    overAllowance.providers.workersAi.models = [{
      ...overAllowance.providers.workersAi.models[0],
      consumedMicroUsd: 100_000,
    }];
    render(<UsageSettingsCard summary={overAllowance} />);

    expect(screen.getAllByText("$0.00", { selector: "dd" })).toHaveLength(3);
    const anthropic = screen.getByRole("heading", { name: "Anthropic" }).closest("article") as HTMLElement;
    expect(within(anthropic).getByText("Consumed", { selector: "dt" }).parentElement?.textContent).toContain("$13.00");
    const zeroAllowanceProgress = screen.getByRole("progressbar", { name: "Workers AI monthly app allowance consumed" });
    expect(zeroAllowanceProgress.getAttribute("max")).toBe("1");
    expect(zeroAllowanceProgress.getAttribute("value")).toBe("1");
    expect(zeroAllowanceProgress.getAttribute("aria-valuetext")).toBe("$0.10 consumed of $0.00 monthly app allowance");
    expect(screen.queryByText(/-\$|NaN|Infinity/)).toBeNull();
  });

  it("keeps the newest usage refresh when an older request finishes later", async () => {
    let resolveFirstUsage!: (response: Response) => void;
    let usageRequestCount = 0;
    const firstUsage = new Promise<Response>((resolve) => { resolveFirstUsage = resolve; });
    const newestUsage = structuredClone(separatedUsageSummary);
    newestUsage.providers.anthropic.consumedMicroUsd = 3_000_000;
    newestUsage.providers.anthropic.remainingMicroUsd = 9_000_000;
    newestUsage.providers.anthropic.models[0].consumedMicroUsd = 3_000_000;
    const { request, user } = await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") return learningJson(enabledLearningStatus);
      if (String(input) === "/api/usage") {
        usageRequestCount += 1;
        return usageRequestCount === 1 ? firstUsage : learningJson(newestUsage);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path) === "/api/usage")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path) === "/api/usage")).toHaveLength(2));
    const anthropic = (await screen.findByRole("heading", { name: "Anthropic" })).closest("article") as HTMLElement;
    await waitFor(() => expect(within(anthropic).getByText("Consumed").parentElement?.textContent).toBe("Consumed$3.00"));

    await act(async () => resolveFirstUsage(learningJson(separatedUsageSummary)));
    await waitFor(() => expect(within(anthropic).getByText("Consumed").parentElement?.textContent).toBe("Consumed$3.00"));
  });

  it("retains the last server summary when a later refresh is unavailable", async () => {
    let usageRequestCount = 0;
    const { user } = await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") return learningJson(enabledLearningStatus);
      if (String(input) === "/api/usage") {
        usageRequestCount += 1;
        if (usageRequestCount === 1) return learningJson(separatedUsageSummary);
        throw new Error("offline");
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const accountUsage = await screen.findByRole("region", { name: "This signed-in account" });
    expect(within(accountUsage).getByRole("heading", { name: "Workers AI" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect(await within(accountUsage).findByText("App allowances are temporarily unavailable. Showing the last recorded summary.")).toBeTruthy();
    expect(within(accountUsage).getByText("Workers AI")).toBeTruthy();
    expect(within(accountUsage).queryByText(/Loading current app allowances/)).toBeNull();
  });
});

describe("approved cloud learning settings", () => {
  it("uses a neutral status while the signed-in account check is still loading", async () => {
    await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") return new Promise<Response>(() => undefined);
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    expect(screen.getByRole("heading", { name: "Checking cloud learning" })).toBeTruthy();
    expect(screen.queryByText("Cloud learning status unavailable")).toBeNull();
    expect(screen.queryByText("Advanced")).toBeNull();
  });

  it("shows automatic cloud learning and server counts compactly while Advanced stays closed", async () => {
    const { request } = await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") return learningJson(enabledLearningStatus);
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    expect(await screen.findByText("Cloud learning enabled")).toBeTruthy();
    expect(screen.getByText("4 classifier / 3 evaluation / 2 authored examples")).toBeTruthy();
    expect(screen.getByText(/stored for 365 days/i)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Enable encrypted personal learning" })).toBeNull();
    expect(screen.queryByText("Learn only from examples you approve")).toBeNull();
    expect(screen.queryByText("LOCAL TRAINING READINESS")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download training manifest" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download manifest" })).toBeNull();
    expect(request.mock.calls.filter(([path, init]) => String(path).startsWith("/api/learning/records") && init?.method === "GET")).toHaveLength(0);
  });

  it("announces a failed status refresh without exposing stale management controls", async () => {
    await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") throw new Error("offline");
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Cloud learning status is temporarily unavailable");
    expect(screen.getByRole("heading", { name: "Cloud learning status unavailable" })).toBeTruthy();
    expect(screen.queryByText("Manage learning records")).toBeNull();
    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable and delete cloud learning" })).toBeNull();
  });

  it("removes previously loaded controls when a later status refresh fails", async () => {
    let statusRequests = 0;
    const { user } = await renderLearningSettings(async (input) => {
      if (String(input) === "/api/learning/status") {
        statusRequests += 1;
        if (statusRequests === 2) throw new Error("offline");
        return learningJson(enabledLearningStatus);
      }
      if (String(input) === "/api/learning/records") return learningJson({ records: [learningRecord("generative", "generative-stale")], nextCursor: null });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    expect(await screen.findByText("Cloud learning enabled")).toBeTruthy();
    await user.click(screen.getByText("Advanced"));
    expect(await screen.findByText("Thanks [contact], what area interests you?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Settings" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Cloud learning status is temporarily unavailable");
    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable and delete cloud learning" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Cloud learning enabled")).toBeTruthy();
    expect(screen.getByText("Advanced").parentElement?.hasAttribute("open")).toBe(false);
    expect(screen.queryByText("Thanks [contact], what area interests you?")).toBeNull();
    expect(statusRequests).toBe(3);
  });

  it("loads bounded pages only after Advanced opens and shows text only for sanitized generative rows", async () => {
    const rawClassifierMessage = "RAW CLASSIFIER MESSAGE MUST NOT APPEAR";
    const providerDraft = "PROVIDER DRAFT MUST NOT APPEAR";
    const { request, user } = await renderLearningSettings(async (input, init) => {
      const path = String(input);
      if (path === "/api/learning/status") return learningJson(enabledLearningStatus);
      if (path === "/api/learning/records" && init?.method === "GET") return learningJson({
        records: [learningRecord("classifier", "classifier-1"), learningRecord("generative", "generative-1")],
        nextCursor: firstLearningCursor,
      });
      if (path === `/api/learning/records?cursor=${encodeURIComponent(firstLearningCursor)}` && init?.method === "GET") return learningJson({
        records: [learningRecord("evaluation", "evaluation-1")],
        nextCursor: null,
      });
      throw new Error(`${rawClassifierMessage} ${providerDraft}`);
    });

    expect(request.mock.calls.filter(([path]) => String(path).startsWith("/api/learning/records"))).toHaveLength(0);
    await user.click(await screen.findByText("Advanced"));
    expect(await screen.findByText("Thanks [contact], what area interests you?")).toBeTruthy();
    expect(screen.queryByText(rawClassifierMessage)).toBeNull();
    expect(screen.queryByText(providerDraft)).toBeNull();
    expect(request.mock.calls.filter(([path]) => String(path).startsWith("/api/learning/records"))).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Load more learning records" }));
    expect(await screen.findByText("Evaluation")).toBeTruthy();
    expect(request.mock.calls.filter(([path]) => String(path).startsWith("/api/learning/records"))).toHaveLength(2);
  });

  it("keeps a management row until scoped server deletion succeeds", async () => {
    let deleteAttempts = 0;
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { user } = await renderLearningSettings(async (input, init) => {
      const path = String(input);
      if (path === "/api/learning/status") return learningJson(enabledLearningStatus);
      if (path === "/api/learning/records" && init?.method === "GET") return learningJson({
        records: [learningRecord("generative", "generative-1")],
        nextCursor: null,
      });
      if (path === "/api/learning/records/generative-1" && init?.method === "DELETE") {
        deleteAttempts += 1;
        return deleteAttempts === 1
          ? learningJson({ error: "temporarily unavailable" }, 503)
          : learningJson({ deleted: true, recordId: "generative-1" });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });
    await user.click(await screen.findByText("Advanced"));
    expect(await screen.findByText("Thanks [contact], what area interests you?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete generative learning record" }));
    expect(await screen.findByText("Cloud learning deletion pending")).toBeTruthy();
    expect(screen.getByText("Thanks [contact], what area interests you?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete generative learning record" }));
    await waitFor(() => expect(screen.queryByText("Thanks [contact], what area interests you?")).toBeNull());
    expect(deleteAttempts).toBe(2);
  });

  it("clears loaded rows and ignores a deferred records page after atomic disable", async () => {
    let resolveRecords!: (response: Response) => void;
    const recordsResponse = new Promise<Response>((resolve) => { resolveRecords = resolve; });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { request, user } = await renderLearningSettings(async (input, init) => {
      const path = String(input);
      if (path === "/api/learning/status") return learningJson(enabledLearningStatus);
      if (path === "/api/learning/records" && init?.method === "GET") return recordsResponse;
      if (path === "/api/learning" && init?.method === "DELETE") return learningJson({ enabled: false, deleted: 9 });
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });
    await user.click(await screen.findByText("Advanced"));
    await waitFor(() => expect(request.mock.calls.some(([path, init]) => String(path) === "/api/learning/records" && init?.method === "GET")).toBe(true));

    await user.click(screen.getByRole("button", { name: "Disable and delete cloud learning" }));
    expect(await screen.findByText("Cloud learning disabled and deleted")).toBeTruthy();
    await act(async () => resolveRecords(learningJson({ records: [learningRecord("generative", "generative-late")], nextCursor: null })));

    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.queryByText("Thanks [contact], what area interests you?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download manifest" })).toBeNull();
  });

  it("does not let a status request completed after atomic disable restore enabled state", async () => {
    let statusRequests = 0;
    let resolveLateStatus!: (response: Response) => void;
    let resolveDelete!: (response: Response) => void;
    const lateStatus = new Promise<Response>((resolve) => { resolveLateStatus = resolve; });
    const deleteResponse = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { request, user } = await renderLearningSettings(async (input, init) => {
      const path = String(input);
      if (path === "/api/learning/status") {
        statusRequests += 1;
        return statusRequests === 1 ? learningJson(enabledLearningStatus) : lateStatus;
      }
      if (path === "/api/learning" && init?.method === "DELETE") return deleteResponse;
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });
    expect(await screen.findByText("Cloud learning enabled")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Disable and delete cloud learning" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path) === "/api/learning/status")).toHaveLength(2));
    await act(async () => resolveDelete(learningJson({ enabled: false, deleted: 9 })));
    expect(await screen.findByText("Cloud learning disabled")).toBeTruthy();
    await act(async () => resolveLateStatus(learningJson(enabledLearningStatus)));

    await waitFor(() => expect(screen.getByText("Cloud learning disabled")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Disable and delete cloud learning" })).toBeNull();
  });

  it("lets confirmed scoped deletion win over a delayed direct-upload acknowledgement", async () => {
    let uploadRecordId = "";
    let resolveUpload!: (response: Response) => void;
    const uploadResponse = new Promise<Response>((resolve) => { resolveUpload = resolve; });
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/learning/records" && init?.method === "PUT") {
        uploadRecordId = JSON.parse(init.body as string).records[0].recordId;
        return uploadResponse;
      }
      if (path === "/api/learning/status" && init?.method === "GET") {
        return Promise.resolve(learningJson({ ...enabledLearningStatus, counts: { classifier: 0, evaluation: 1, generative: 0 } }));
      }
      if (path === "/api/learning/records" && init?.method === "GET") {
        return Promise.resolve(learningJson({ records: [learningRecord("evaluation", uploadRecordId)], nextCursor: null }));
      }
      if (path === `/api/learning/records/${uploadRecordId}` && init?.method === "DELETE") {
        return Promise.resolve(learningJson({ deleted: true, recordId: uploadRecordId }));
      }
      return Promise.resolve(learningJson({ error: "unexpected request" }, 503));
    }));
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Save improvement" }));
    await user.click(screen.getByRole("button", { name: "Rate this draft" }));
    await user.click(screen.getByRole("button", { name: "Useful" }));
    await waitFor(() => expect(uploadRecordId).not.toBe(""));
    await user.click(screen.getByRole("button", { name: "Close improvement dialog" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByText("Advanced"));
    expect(await screen.findByText("Evaluation")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete evaluation learning record" }));
    await waitFor(() => expect(screen.queryByText("Evaluation")).toBeNull());
    expect(screen.getByText("0 classifier / 0 evaluation / 0 authored examples")).toBeTruthy();
    await waitFor(async () => {
      const saved = (await openDeviceVault()).workspace;
      expect(saved.pendingLearningRecords).toEqual([]);
      expect(saved.cloudLearningSync).toEqual([]);
      expect(saved.cloudLearningDeletionMarkers).toEqual([expect.objectContaining({ recordId: uploadRecordId, disposition: "deleted", sourceCollection: "feedback", sourceLocalId: uploadRecordId })]);
    });

    await act(async () => resolveUpload(learningJson({ accepted: [{ recordId: uploadRecordId, contentDigest: "d".repeat(64) }], duplicates: [] })));
    await waitFor(async () => {
      const saved = (await openDeviceVault()).workspace;
      expect(saved.pendingLearningRecords).toEqual([]);
      expect(saved.cloudLearningSync).toEqual([]);
      expect(saved.cloudLearningDeletionMarkers).toEqual([expect.objectContaining({ recordId: uploadRecordId, disposition: "deleted" })]);
    });
  }, 20_000);
});
