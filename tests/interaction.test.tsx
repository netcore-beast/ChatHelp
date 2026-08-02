// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
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
  URL.createObjectURL = vi.fn(() => "blob:local-screen-preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => cleanup());

describe("secure workspace interaction", () => {
  it("creates, edits, locks, rejects a wrong key, and unlocks the encrypted vault", async () => {
    const user = userEvent.setup();
    render(<ChatHelpApp />);

    expect(await screen.findByRole("heading", { name: /conversations stay under your key/i })).toBeTruthy();
    await user.type(screen.getByLabelText("Passphrase"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Confirm passphrase"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /create encrypted workspace/i }));

    expect(await screen.findByRole("heading", { name: /private conversation studio/i })).toBeTruthy();
    await user.type(screen.getByLabelText("New contact name"), "Alex Morgan");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("heading", { name: "Alex Morgan" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Alex Morgan's LinkedIn profile" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Capture Alex Morgan's profile screen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Capture conversation messages with Alex Morgan" })).toBeTruthy();
    expect(screen.getByText("No LLM model is downloaded or run on this device.")).toBeTruthy();
    expect(screen.queryByLabelText("AI provider")).toBeNull();
    expect((screen.getByRole("button", { name: "Generate 3 cloud drafts for Alex Morgan" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Capture conversation messages with Alex Morgan" }));
    expect(await screen.findByRole("heading", { name: "Select only Alex Morgan's message history" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use selected message area" }));
    const capturedText = await screen.findByLabelText("Captured conversation text for Alex Morgan");
    expect(capturedText.textContent).toBe("Alex\nThanks for connecting.\nYou\nWhat are you working on now?");
    expect(screen.getByText("Exact locally extracted text used as conversation history")).toBeTruthy();

    await waitFor(() => expect(document.querySelector(".save-state")?.textContent).toContain("Encrypted"), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Lock" }));
    expect(await screen.findByRole("button", { name: /unlock private workspace/i })).toBeTruthy();

    const passphrase = screen.getByLabelText("Passphrase");
    await user.type(passphrase, "incorrect passphrase value");
    await user.click(screen.getByRole("button", { name: /unlock private workspace/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect passphrase/);

    await user.clear(passphrase);
    await user.type(passphrase, "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: /unlock private workspace/i }));
    expect(await screen.findByRole("heading", { name: "Alex Morgan" })).toBeTruthy();
  }, 20_000);
});
