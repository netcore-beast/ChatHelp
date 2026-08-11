// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { AddOwnVersionDialog } from "../src/components/AddOwnVersionDialog";
import { CompletedDraftCard, type CompletedDraftCardProps } from "../src/components/CompletedDraftCard";
import { UsageSettingsCard } from "../src/components/UsageSettingsCard";
import type { CloudUsageSummary } from "../src/lib/cloudUsage";
import { createDeviceVault, openDeviceVault, resetVaultForTests } from "../src/lib/secureVault";
import { createEmptyWorkspace } from "../src/lib/workspaceTypes";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const providerDraft = "Thanks, Taylor at Example Co. I can share the role brief here.";

async function renderCompletedDraft(options: { secondContact?: boolean } = {}, configureNavigator?: () => void) {
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
  const user = userEvent.setup();
  configureNavigator?.();
  render(<ChatHelpApp />);
  await screen.findByRole("heading", { name: /private conversation studio/i });
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


function completedDraftCardProps(overrides: Partial<CompletedDraftCardProps> = {}): CompletedDraftCardProps {
  return {
    draft: providerDraft,
    learningStatus: { kind: "idle" },
    onDraftChange: vi.fn(),
    onDraftBlur: vi.fn(),
    onCopy: vi.fn(),
    onUseful: vi.fn(),
    onNotUseful: vi.fn(),
    onAddOwnVersion: vi.fn(),
    ...overrides,
  };
}

function renderCompletedDraftCard(overrides: Partial<CompletedDraftCardProps> = {}) {
  const props = completedDraftCardProps(overrides);
  return { ...render(<CompletedDraftCard {...props} />), props };
}

describe("direct draft learning controls", () => {
  it("stages the active history decision and sends a text-free useful request", async () => {
    const postMessage = vi.spyOn(window, "postMessage");
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const recordId = String(input).split("/").at(-1)!;
      return learningJson({ recordId, decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T12:00:00.000Z" });
    });
    vi.stubGlobal("fetch", request);
    const user = await renderCompletedDraft();

    await user.click(screen.getByRole("button", { name: "Useful" }));

    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][0]).toBe("/api/learning/decisions/learning-decision-completed-draft-set");
    expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toEqual({ decision: {
      kind: "evaluation", roleId: "human_resource", relationshipStage: "learn_interests", goalCategory: "discover_interests", action: "useful",
    } });
    expect(JSON.stringify(request.mock.calls[0][1]?.body)).not.toContain(providerDraft);
    expect(screen.getByRole("button", { name: "Useful" }).getAttribute("aria-pressed")).toBe("true");
    expect(postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === "CHATHELP_LINKEDIN_SYNC_COMMAND")).toBe(false);
  });

  it("copies before marking the same decision useful on every successful copy", async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.spyOn(window, "postMessage");
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const recordId = String(input).split("/").at(-1)!;
      return learningJson({ recordId, decision: "useful", recordKind: "evaluation", contentDigest: "c".repeat(64), changed: true, updatedAt: "2026-08-10T12:00:00.000Z" });
    });
    vi.stubGlobal("fetch", request);
    const user = await renderCompletedDraft({}, () => {
      vi.spyOn(navigator.clipboard, "writeText").mockImplementation(clipboardWriteText);
    });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path).includes("/api/learning/decisions/"))).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => String(path).includes("/api/learning/decisions/"))).toHaveLength(2));

    expect(clipboardWriteText).toHaveBeenCalledTimes(2);
    expect(clipboardWriteText.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder.find((_, index) => String(request.mock.calls[index][0]).includes("/api/learning/decisions/"))!);
    expect(request.mock.calls.filter(([path]) => String(path).includes("/api/learning/decisions/")).map(([path]) => path)).toEqual([
      "/api/learning/decisions/learning-decision-completed-draft-set",
      "/api/learning/decisions/learning-decision-completed-draft-set",
    ]);
    expect(postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === "CHATHELP_LINKEDIN_SYNC_COMMAND")).toBe(false);
  });

  it("does not save learning when clipboard access is rejected", async () => {
    const clipboardWriteText = vi.fn().mockRejectedValue(new Error("blocked"));
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const user = await renderCompletedDraft({}, () => {
      vi.spyOn(navigator.clipboard, "writeText").mockImplementation(clipboardWriteText);
    });

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByText("Clipboard access was blocked.")).toBeTruthy();
    expect(clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(([path]) => String(path).includes("/api/learning/decisions/"))).toBe(false);
  });

  it("replaces a negative decision with an authored version under the active history record ID", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const postMessage = vi.spyOn(window, "postMessage");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const body = JSON.parse(String(init?.body));
      requests.push({ path, body });
      const decision = body.decision as { kind: string; action?: string };
      return learningJson({
        recordId: path.split("/").at(-1),
        decision: decision.kind === "generative" ? "authored" : decision.action,
        recordKind: decision.kind === "generative" ? "generative" : "evaluation",
        contentDigest: "b".repeat(64),
        changed: true,
        updatedAt: "2026-08-10T12:01:00.000Z",
      });
    }));
    const user = await renderCompletedDraft();

    await user.click(screen.getByRole("button", { name: "Not useful" }));
    await screen.findByRole("button", { name: "Add my own version" });
    await user.click(screen.getByRole("button", { name: "Add my own version" }));
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "Thanks Taylor Lee at Example Co, which detail matters most?");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }));
    await user.click(screen.getByRole("button", { name: "Save approved example" }));

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map((request) => request.path)).toEqual([
      "/api/learning/decisions/learning-decision-completed-draft-set",
      "/api/learning/decisions/learning-decision-completed-draft-set",
    ]);
    expect(requests[0].body).toEqual({ decision: {
      kind: "evaluation", roleId: "human_resource", relationshipStage: "learn_interests", goalCategory: "discover_interests", action: "not_useful",
    } });
    expect(requests[1].body).toEqual({
      decision: {
        kind: "generative", roleId: "human_resource", relationshipStage: "learn_interests", goalCategory: "discover_interests",
        provenance: "independently_user_authored", target: "Thanks [contact] at [company], which detail matters most?", rightsAttested: true, privacyAttested: true,
      },
      knownIdentifiers: { contactName: "Taylor Lee", company: "Example Co", profileUrl: "https://www.linkedin.com/in/taylor-lee/", profileHandle: "taylor-lee" },
    });
    expect(screen.getByRole("button", { name: "Useful" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Add my own version" })).toBeNull();
    const saved = (await openDeviceVault()).workspace;
    expect(JSON.stringify(saved.pendingLearningRecords)).not.toContain("Taylor Lee");
    expect(JSON.stringify(saved.pendingLearningRecords)).not.toContain("Example Co");
    expect(postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === "CHATHELP_LINKEDIN_SYNC_COMMAND")).toBe(false);
  });

  it("does not let a deferred retry overwrite a newer authored decision for the same history record", async () => {
    let decisionAttempts = 0;
    const postMessage = vi.spyOn(window, "postMessage");
    let resolveRetry!: (response: Response) => void;
    const retryResponse = new Promise<Response>((resolve) => { resolveRetry = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (!path.includes("/api/learning/decisions/")) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
      const decision = JSON.parse(String(init?.body)).decision as { kind: string; action?: string };
      if (decision.kind === "evaluation") {
        decisionAttempts += 1;
        if (decisionAttempts === 1) return learningJson({ error: "temporarily unavailable" }, 503);
        return retryResponse;
      }
      return learningJson({ recordId: "learning-decision-completed-draft-set", decision: "authored", recordKind: "generative", contentDigest: "e".repeat(64), changed: true, updatedAt: "2026-08-10T12:03:00.000Z" });
    }));
    const user = await renderCompletedDraft();

    await user.click(screen.getByRole("button", { name: "Not useful" }));
    await screen.findByRole("button", { name: "Retry learning sync" });
    await user.click(screen.getByRole("button", { name: "Retry learning sync" }));
    await waitFor(() => expect(decisionAttempts).toBe(2));
    await user.click(screen.getByRole("button", { name: "Add my own version" }));
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "I wrote this replacement myself.");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }));
    await user.click(screen.getByRole("button", { name: "Save approved example" }));
    await screen.findByText("Learning saved");

    await act(async () => resolveRetry(learningJson({ recordId: "learning-decision-completed-draft-set", decision: "not_useful", recordKind: "evaluation", contentDigest: "f".repeat(64), changed: true, updatedAt: "2026-08-10T12:04:00.000Z" })));
    await waitFor(async () => {
      const saved = (await openDeviceVault()).workspace;
      expect(saved.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ state: "authored", syncStatus: "synced" });
      expect(saved.pendingLearningRecords).toEqual([]);
    });
    expect(postMessage.mock.calls.some(([message]) => (message as { type?: string }).type === "CHATHELP_LINKEDIN_SYNC_COMMAND")).toBe(false);
  });

  it("replaces failed activity with saved activity when the same direct decision retry succeeds", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      attempt += 1;
      if (attempt === 1) return Promise.resolve(learningJson({ error: "temporarily unavailable" }, 503));
      const recordId = String(input).split("/").at(-1)!;
      return Promise.resolve(learningJson({ recordId, decision: "not_useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T12:08:00.000Z" }));
    }));
    const user = await renderCompletedDraft();

    await user.click(screen.getByRole("button", { name: "Not useful" }));
    await user.click(await screen.findByRole("button", { name: "Retry learning sync" }));

    expect(await screen.findByText("Learning saved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry learning sync" })).toBeNull();
  });

  it("persists a deferred decision for its source draft without showing saved activity after a contact switch", async () => {
    let resolvePut!: (response: Response) => void;
    const putResponse = new Promise<Response>((resolve) => { resolvePut = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => putResponse));
    const user = await renderCompletedDraft({ secondContact: true });

    await user.click(screen.getByRole("button", { name: "Useful" }));
    await user.click(screen.getByRole("button", { name: "Open conversation with Morgan Chen" }));
    await act(async () => resolvePut(learningJson({ recordId: "learning-decision-completed-draft-set", decision: "useful", recordKind: "evaluation", contentDigest: "a".repeat(64), changed: true, updatedAt: "2026-08-10T12:07:00.000Z" })));

    await waitFor(async () => expect((await openDeviceVault()).workspace.contacts[0].draftHistory?.[0].learningDecision).toMatchObject({ state: "useful", syncStatus: "synced" }));
    expect(screen.queryByText("Learning saved")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open conversation with Taylor Lee" }));
    expect(screen.getByRole("button", { name: "Useful" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Learning saved")).toBeNull();
  });

  it("shows only Copy Useful and Not useful as completed-draft actions", () => {
    renderCompletedDraftCard();

    for (const label of ["Copy", "Useful", "Not useful"]) expect(screen.getByRole("button", { name: label })).toBeTruthy();
    for (const label of ["Mark sent", "Save improvement", "More", "Dismiss", "Accept", "Save edit", "Reject"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("routes each direct card action through its dedicated callback", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    const onUseful = vi.fn();
    const onNotUseful = vi.fn();
    renderCompletedDraftCard({ onCopy, onUseful, onNotUseful });
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await user.click(screen.getByRole("button", { name: "Useful" }));
    await user.click(screen.getByRole("button", { name: "Not useful" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onUseful).toHaveBeenCalledTimes(1);
    expect(onNotUseful).toHaveBeenCalledTimes(1);
  });

  it("marks durable decisions accessibly and exposes authored replacement only after a negative decision", async () => {
    const user = userEvent.setup();
    const onAddOwnVersion = vi.fn();
    const { rerender } = renderCompletedDraftCard({
      learningDecision: { recordId: "learning-decision-card", state: "not_useful", syncStatus: "pending", updatedAt: "2026-08-10T12:00:00.000Z" },
      onAddOwnVersion,
    });
    expect(screen.getByRole("button", { name: "Useful" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Not useful" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Add my own version" }));
    expect(onAddOwnVersion).toHaveBeenCalledTimes(1);

    rerender(<CompletedDraftCard {...completedDraftCardProps({
      learningDecision: { recordId: "learning-decision-card", state: "authored", syncStatus: "synced", updatedAt: "2026-08-10T12:01:00.000Z" },
    })} />);
    expect(screen.getByRole("button", { name: "Useful" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Not useful" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Add my own version" })).toBeNull();
  });

  it("renders saved inside Ready to review and leaves failure retryable", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = renderCompletedDraftCard({ learningStatus: { kind: "saved", acknowledgementId: "digest-1" } });
    expect(screen.getByText("Learning saved").closest("header")?.textContent).toContain("READY TO REVIEW");

    rerender(<CompletedDraftCard {...completedDraftCardProps({ learningStatus: { kind: "failed", onRetry } })} />);
    await user.click(screen.getByRole("button", { name: "Retry learning sync" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("announces saving while idle reserves space without learning text", () => {
    const { rerender } = renderCompletedDraftCard();
    expect(screen.queryByText(/learning/i)).toBeNull();
    rerender(<CompletedDraftCard {...completedDraftCardProps({ learningStatus: { kind: "saving" } })} />);
    expect(screen.getByRole("status").textContent).toBe("Saving learning…");
  });

  it("keeps the saved acknowledgement visible for three seconds without moving focus", async () => {
    vi.useFakeTimers();
    const { rerender } = renderCompletedDraftCard({ learningStatus: { kind: "saved", acknowledgementId: "digest-1" } });
    const copy = screen.getByRole("button", { name: "Copy" });
    copy.focus();
    rerender(<CompletedDraftCard {...completedDraftCardProps({ learningStatus: { kind: "saved", acknowledgementId: "digest-2" } })} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_999); });
    expect(screen.getByText("Learning saved")).toBeTruthy();
    expect(document.activeElement).toBe(copy);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByText("Learning saved")).toBeNull();
    vi.useRealTimers();
  });

  it("does not restart a saved acknowledgement timer when its parent rerenders the same ID", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderCompletedDraftCard({ learningStatus: { kind: "saved", acknowledgementId: "digest-stable" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      rerender(<CompletedDraftCard {...completedDraftCardProps({ learningStatus: { kind: "saved", acknowledgementId: "digest-stable" } })} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(screen.getByText("Learning saved")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.queryByText("Learning saved")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("remounts a saved acknowledgement by ID so each confirmed learning save enters visibly", () => {
    const { rerender } = renderCompletedDraftCard({ learningStatus: { kind: "saved", acknowledgementId: "digest-1" } });
    const firstAnnouncement = screen.getByText("Learning saved");
    rerender(<CompletedDraftCard {...completedDraftCardProps({ learningStatus: { kind: "saved", acknowledgementId: "digest-2" } })} />);
    const secondAnnouncement = screen.getByText("Learning saved");
    expect(secondAnnouncement).not.toBe(firstAnnouncement);
  });
});

describe("authored-only draft learning dialog", () => {
  const identifiers = { contactName: "Taylor Lee", company: "Example Co", profileUrl: "", profileHandle: "" };

  it("starts blank, keeps provider text out, and requires both attestations for the exact sanitized preview", async () => {
    const user = userEvent.setup();
    const onSaveIndependent = vi.fn();
    render(<AddOwnVersionDialog knownIdentifiers={identifiers} onClose={vi.fn()} onSaveIndependent={onSaveIndependent} />);
    const editor = screen.getByRole("textbox", { name: "Your independently written response" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    expect(screen.queryByText(providerDraft)).toBeNull();
    expect(screen.queryByRole("button", { name: "Rate this draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    await user.type(editor, "Thanks Taylor Lee at Example Co, which detail matters most?");
    expect((screen.getByRole("status", { name: "Sanitized preview" }) as HTMLOutputElement).value).toBe("Thanks [contact] at [company], which detail matters most?");
    const save = screen.getByRole("button", { name: "Save approved example" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }));
    expect(save.disabled).toBe(false);
    await user.click(save);
    expect(onSaveIndependent).toHaveBeenCalledWith({ sanitizedTarget: "Thanks [contact] at [company], which detail matters most?", rightsAttested: true, privacyAttested: true });
  });

  it("invalidates privacy approval when the exact preview changes or identifiers change", async () => {
    const user = userEvent.setup();
    const callbacks = { onClose: vi.fn(), onSaveIndependent: vi.fn() };
    const { rerender } = render(<AddOwnVersionDialog knownIdentifiers={identifiers} {...callbacks} />);
    const editor = screen.getByRole("textbox", { name: "Your independently written response" });
    await user.type(editor, "Thanks Taylor Lee at Example Co, which detail matters most?");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    const privacy = screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }) as HTMLInputElement;
    await user.click(privacy);
    expect(privacy.checked).toBe(true);
    await user.type(editor, " Please.");
    expect(privacy.checked).toBe(false);
    await user.click(privacy);
    rerender(<AddOwnVersionDialog knownIdentifiers={{ ...identifiers, contactName: "Morgan Chen", company: "Northwind" }} {...callbacks} />);
    expect((screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("keeps the dialog open and reports a safe error when authored save fails", async () => {
    const user = userEvent.setup();
    render(<AddOwnVersionDialog knownIdentifiers={identifiers} onClose={vi.fn()} onSaveIndependent={vi.fn().mockRejectedValue(new Error("offline"))} />);
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "What detail should we explore next?");
    await user.click(screen.getByRole("checkbox", { name: /I wrote this response independently/ }));
    await user.click(screen.getByRole("checkbox", { name: /I reviewed the sanitized preview/ }));
    await user.click(screen.getByRole("button", { name: "Save approved example" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The improvement could not be saved. Please try again.");
    expect(screen.getByRole("dialog", { name: "Add your independently written version" })).toBeTruthy();
  });

  it("tears down the dialog when its active contact changes", async () => {
    const user = userEvent.setup();
    function ContactHarness() {
      const [contactId, setContactId] = React.useState("taylor");
      const [openFor, setOpenFor] = React.useState<string | null>(null);
      return <>
        <button type="button" onClick={() => setOpenFor(contactId)}>Add own version for active contact</button>
        <button type="button" onClick={() => setContactId("morgan")}>Open Morgan Chen</button>
        {openFor === contactId && <AddOwnVersionDialog knownIdentifiers={contactId === "taylor" ? identifiers : { ...identifiers, contactName: "Morgan Chen" }} onClose={() => setOpenFor(null)} onSaveIndependent={vi.fn()} />}
      </>;
    }
    render(<ContactHarness />);
    await user.click(screen.getByRole("button", { name: "Add own version for active contact" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Morgan Chen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects detectable identifiers and traps focus, Escape, and return focus without LinkedIn commands", async () => {
    const user = userEvent.setup();
    const postMessage = vi.spyOn(window, "postMessage");
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Add my own version</button>{open && <AddOwnVersionDialog knownIdentifiers={identifiers} onClose={() => setOpen(false)} onSaveIndependent={vi.fn()} />}</>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Add my own version" });
    await user.click(opener);
    const close = screen.getByRole("button", { name: "Close improvement dialog" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Your independently written response" }));
    await user.type(screen.getByRole("textbox", { name: "Your independently written response" }), "Please email me at example@example.com");
    expect(screen.getByRole("alert").textContent).toContain("Remove the email address before saving.");
    close.focus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(screen.getAllByRole("checkbox").at(-1));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(postMessage).not.toHaveBeenCalled();
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

  it("clears an acknowledged direct decision only after its scoped server deletion succeeds", async () => {
    const recordId = "learning-decision-completed-draft-set";
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/learning/decisions/${recordId}` && init?.method === "PUT") {
        return Promise.resolve(learningJson({ recordId, decision: "useful", recordKind: "evaluation", contentDigest: "d".repeat(64), changed: true, updatedAt: "2026-08-10T12:00:00.000Z" }));
      }
      if (path === "/api/learning/status" && init?.method === "GET") {
        return Promise.resolve(learningJson({ ...enabledLearningStatus, counts: { classifier: 0, evaluation: 1, generative: 0 } }));
      }
      if (path === "/api/learning/records" && init?.method === "GET") {
        return Promise.resolve(learningJson({ records: [learningRecord("evaluation", recordId)], nextCursor: null }));
      }
      if (path === `/api/learning/records/${recordId}` && init?.method === "DELETE") {
        return Promise.resolve(learningJson({ deleted: true, recordId }));
      }
      return Promise.resolve(learningJson({ error: "unexpected request" }, 503));
    }));
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Useful" }));
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
      expect(saved.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
      expect(saved.cloudLearningDeletionMarkers).toEqual([expect.objectContaining({ recordId, disposition: "deleted", sourceCollection: "draftHistory", sourceLocalId: "completed-draft-set" })]);
    });
  }, 20_000);

  it("does not restore a direct decision or saved activity after Settings deletes it while its request is pending", async () => {
    const recordId = "learning-decision-completed-draft-set";
    let resolvePut!: (response: Response) => void;
    const putResponse = new Promise<Response>((resolve) => { resolvePut = resolve; });
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/learning/decisions/${recordId}` && init?.method === "PUT") return putResponse;
      if (path === "/api/learning/status" && init?.method === "GET") return Promise.resolve(learningJson({ ...enabledLearningStatus, counts: { classifier: 0, evaluation: 1, generative: 0 } }));
      if (path === "/api/learning/records" && init?.method === "GET") return Promise.resolve(learningJson({ records: [learningRecord("evaluation", recordId)], nextCursor: null }));
      if (path === `/api/learning/records/${recordId}` && init?.method === "DELETE") return Promise.resolve(learningJson({ deleted: true, recordId }));
      return Promise.resolve(learningJson({ error: "unexpected request" }, 503));
    }));
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Useful" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByText("Advanced"));
    await user.click(screen.getByRole("button", { name: "Delete evaluation learning record" }));
    await waitFor(async () => expect((await openDeviceVault()).workspace.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined());

    await act(async () => resolvePut(learningJson({ recordId, decision: "useful", recordKind: "evaluation", contentDigest: "d".repeat(64), changed: true, updatedAt: "2026-08-10T12:05:00.000Z" })));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await waitFor(async () => {
      const saved = (await openDeviceVault()).workspace;
      expect(saved.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
      expect(saved.pendingLearningRecords).toEqual([]);
    });
    expect(screen.queryByText("Learning saved")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry learning sync" })).toBeNull();
  }, 20_000);

  it("does not restore a direct decision or saved activity after global disable while its request is pending", async () => {
    const recordId = "learning-decision-completed-draft-set";
    let resolvePut!: (response: Response) => void;
    const putResponse = new Promise<Response>((resolve) => { resolvePut = resolve; });
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/learning/decisions/${recordId}` && init?.method === "PUT") return putResponse;
      if (path === "/api/learning/status" && init?.method === "GET") return Promise.resolve(learningJson(enabledLearningStatus));
      if (path === "/api/learning" && init?.method === "DELETE") return Promise.resolve(learningJson({ enabled: false, deleted: 1 }));
      return Promise.resolve(learningJson({ error: "unexpected request" }, 503));
    }));
    const user = await renderCompletedDraft();
    await user.click(screen.getByRole("button", { name: "Useful" }));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Disable and delete cloud learning" }));
    expect(await screen.findByText("Cloud learning disabled and deleted")).toBeTruthy();

    await act(async () => resolvePut(learningJson({ recordId, decision: "useful", recordKind: "evaluation", contentDigest: "d".repeat(64), changed: true, updatedAt: "2026-08-10T12:06:00.000Z" })));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    await waitFor(async () => {
      const saved = (await openDeviceVault()).workspace;
      expect(saved.contacts[0].draftHistory?.[0].learningDecision).toBeUndefined();
      expect(saved.pendingLearningRecords).toEqual([]);
      expect(saved.personalLearning.enabled).toBe(false);
    });
    expect(screen.queryByText("Learning saved")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry learning sync" })).toBeNull();
  }, 20_000);
});
