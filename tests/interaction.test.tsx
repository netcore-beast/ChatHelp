// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { LINKEDIN_EXTENSION_SOURCE, LINKEDIN_SNAPSHOT_EVENT } from "../src/lib/linkedinExtension";
import { resetVaultForTests } from "../src/lib/secureVault";

vi.mock("@/lib/localOcr", () => ({
  captureVisibleScreen: vi.fn().mockResolvedValue(new Blob(["screen"])),
  cropImageToRegion: vi.fn().mockImplementation(async (image: Blob) => image),
  extractTextFromImage: vi.fn().mockResolvedValue("Alex\nThanks for connecting.\nYou\nWhat are you working on now?"),
}));

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

beforeEach(async () => {
  await resetVaultForTests();
  localStorage.clear();
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia: vi.fn() }, configurable: true });
  URL.createObjectURL = vi.fn(() => "blob:local-screen-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => cleanup());

describe("secure workspace interaction", () => {
  it("creates, edits, and reopens the device-encrypted vault without a passphrase", async () => {
    const user = userEvent.setup();
    const firstRender = render(<ChatHelpApp />);

    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
    await user.type(screen.getByLabelText("New contact name"), "Alex Morgan");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("heading", { name: "Alex Morgan" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Alex Morgan's LinkedIn profile" })).toBeTruthy();
    expect(await screen.findByText("Screen capture recommended for this desktop")).toBeTruthy();
    expect(screen.getAllByTestId("recommended-linkedin-import")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Check for capture" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Capture Alex Morgan's profile screen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Capture conversation screen" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show other import options" }));
    expect(screen.getByRole("button", { name: "Capture Alex Morgan's profile screen" })).toBeTruthy();
    expect(screen.getByText("No LLM model is downloaded or run on this device.")).toBeTruthy();
    expect(screen.queryByLabelText("AI provider")).toBeNull();
    expect((screen.getByRole("button", { name: "Generate 3 cloud drafts for Alex Morgan" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Capture conversation screen" }));
    expect(await screen.findByRole("heading", { name: "Select only Alex Morgan's message history" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use selected message area" }));
    const capturedText = await screen.findByLabelText("Captured conversation text for Alex Morgan");
    expect(capturedText.textContent).toBe("Alex\nThanks for connecting.\nYou\nWhat are you working on now?");
    expect(screen.getByText("Exact locally extracted text used as conversation history")).toBeTruthy();

    await waitFor(() => expect(document.querySelector(".save-state")?.textContent).toContain("Encrypted"), { timeout: 3000 });
    firstRender.unmount();
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: "Alex Morgan" })).toBeTruthy();
    expect(screen.queryByLabelText("Passphrase")).toBeNull();
  }, 20_000);

  it("imports an explicit extension snapshot into the local inbox without sending", async () => {
    render(<ChatHelpApp />);
    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    window.dispatchEvent(new MessageEvent("message", {
      source: window,
      origin: window.location.origin,
      data: { source: LINKEDIN_EXTENSION_SOURCE, type: "CHATHELP_EXTENSION_READY" },
    }));
    const payload = {
      source: LINKEDIN_EXTENSION_SOURCE,
      version: 1,
      captureId: "capture-ui-1",
      capturedAt: "2026-08-02T12:00:00.000Z",
      pageUrl: "https://www.linkedin.com/messaging/thread/example/",
      contact: { name: "Taylor Lee", headline: "Talent Partner", profileUrl: "https://www.linkedin.com/in/taylor-lee/", avatarUrl: "" },
      messages: [
        { id: "one", role: "them", speaker: "Taylor Lee", body: "Could you share the role brief?", createdAt: "2026-08-02T11:59:00.000Z", attachments: [] },
      ],
    };
    await waitFor(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: { source: LINKEDIN_EXTENSION_SOURCE, type: LINKEDIN_SNAPSHOT_EVENT, payload },
      }));
      expect(screen.getByRole("heading", { name: "Taylor Lee" })).toBeTruthy();
    });
    expect(screen.getAllByText("Could you share the role brief?").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Pipeline stage for Taylor Lee")).toBeTruthy();
    expect(screen.getByText(/1 new visible message/i)).toBeTruthy();
    expect(screen.getByText("Chrome extension connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check for capture" })).toBeNull();
    expect(screen.getByText(/never clicks, types, or sends/i)).toBeTruthy();
  });
});
