// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { SaveImprovementDialog } from "../src/components/SaveImprovementDialog";
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
