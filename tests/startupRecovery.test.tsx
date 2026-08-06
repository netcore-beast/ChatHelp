// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatHelpApp from "../src/components/ChatHelpApp";
import { createCloudSafeWorkspace, createRecoveryBundle, encryptCloudWorkspace, importRecoveryKey, serializeRecoveryBundle, summarizeCloudBackup } from "../src/lib/cloudRecovery";
import { createDeviceVault, openCloudRecoveryKey, openDeviceVault, resetVaultForTests, saveCloudRecoveryKey } from "../src/lib/secureVault";
import { createEmptyWorkspace, type Contact } from "../src/lib/workspaceTypes";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

function contact(): Contact {
  return {
    id: "recovery-contact", name: "Recovery Contact", headline: "", profileNotes: "", platform: "linkedin", platformUrl: "https://www.linkedin.com/in/recovery-contact",
    profileUrl: "https://www.linkedin.com/in/recovery-contact", chat: [{ id: "recovery-message", role: "them", body: "Synthetic recovery message", createdAt: "2026-08-04T00:00:00.000Z" }],
    documents: [], outcomes: [], retentionDays: 90,
  };
}

beforeEach(async () => {
  await resetVaultForTests();
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => "blob:dialogmint-recovery");
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await resetVaultForTests();
});

describe("DialogMint startup recovery and confirmed backup status", () => {
  it("offers restore on an empty local workspace and explains separate Access, AI consent, and backup states", async () => {
    render(<ChatHelpApp />);
    expect(await screen.findByRole("button", { name: "Restore encrypted backup" })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Encrypted 90-day backup" })).toBeTruthy();
    expect(screen.getByText(/Cloudflare Access login authorizes both draft generation and encrypted backup/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Cloud access code/i)).toBeNull();
  });

  it("enables backup only from a user gesture, downloads a recovery file, and stores a non-extractable key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    render(<ChatHelpApp />);
    await screen.findByRole("heading", { name: /private conversation studio/i });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Enable encrypted backup" }));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect((await openCloudRecoveryKey())?.extractable).toBe(false);
    await waitFor(async () => expect((await openDeviceVault()).workspace.cloudRecovery.enabled).toBe(true));
  });

  it("shows exact Neon-confirmed counts and returns to pending immediately after a local mutation", async () => {
    const workspace = createEmptyWorkspace();
    workspace.contacts = [contact()];
    workspace.cloudRecovery.enabled = true;
    await createDeviceVault(workspace);
    const key = await importRecoveryKey((await createRecoveryBundle()).encryptionKey);
    await saveCloudRecoveryKey(key);
    const request = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ revision: 1, ciphertextDigest: body.ciphertextDigest }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);

    render(<ChatHelpApp />);
    expect(await screen.findByText("All 1 conversations backed up · 1 messages", {}, { timeout: 8_000 })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.setup().type(screen.getByLabelText("New contact name"), "New local contact");
    await userEvent.setup().click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getAllByText(/Encrypted backup pending/i).length).toBeGreaterThan(0);
  }, 15_000);

  it("restores an already-backed-up workspace after local browser data is empty", async () => {
    const bundle = await createRecoveryBundle();
    const key = await importRecoveryKey(bundle.encryptionKey);
    const remote = createEmptyWorkspace();
    remote.contacts = [contact()];
    const safe = createCloudSafeWorkspace(remote, "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    const envelope = await encryptCloudWorkspace(safe, key, "testing", "2026-08-05T00:00:00.000Z");
    const summary = await summarizeCloudBackup(safe, envelope);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ envelope, revision: 4, ciphertextDigest: summary.ciphertextDigest }), { headers: { "Content-Type": "application/json" } })));

    render(<ChatHelpApp />);
    await screen.findByRole("button", { name: "Restore encrypted backup" });
    const file = new File([serializeRecoveryBundle(bundle)], "DialogMint-recovery-key.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Choose DialogMint recovery file"), { target: { files: [file] } });

    expect(await screen.findByRole("button", { name: "Open conversation with Recovery Contact" }, { timeout: 8_000 })).toBeTruthy();
    expect((await openCloudRecoveryKey())?.extractable).toBe(false);
  }, 15_000);

  it("does not change local data when the recovery file cannot decrypt the signed-in account backup", async () => {
    const remoteBundle = await createRecoveryBundle();
    const remoteKey = await importRecoveryKey(remoteBundle.encryptionKey);
    const remote = createEmptyWorkspace();
    remote.contacts = [contact()];
    const safe = createCloudSafeWorkspace(remote, "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    const envelope = await encryptCloudWorkspace(safe, remoteKey, "testing", "2026-08-05T00:00:00.000Z");
    const summary = await summarizeCloudBackup(safe, envelope);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ envelope, revision: 4, ciphertextDigest: summary.ciphertextDigest }), { headers: { "Content-Type": "application/json" } })));

    render(<ChatHelpApp />);
    await screen.findByRole("button", { name: "Restore encrypted backup" });
    const unrelatedBundle = await createRecoveryBundle();
    const file = new File([serializeRecoveryBundle(unrelatedBundle)], "DialogMint-recovery-key.json", { type: "application/json" });
    fireEvent.change(screen.getByLabelText("Choose DialogMint recovery file"), { target: { files: [file] } });

    expect((await screen.findByRole("alert")).textContent).toMatch(/does not unlock the encrypted DialogMint backup/i);
    expect(screen.queryByRole("button", { name: "Open conversation with Recovery Contact" })).toBeNull();
    expect((await openDeviceVault()).workspace.contacts).toHaveLength(0);
    expect(await openCloudRecoveryKey()).toBeNull();
  }, 15_000);

  it("deletes only the encrypted cloud backup while retaining the local workspace", async () => {
    const workspace = createEmptyWorkspace();
    workspace.contacts = [contact()];
    workspace.cloudRecovery.enabled = true;
    await createDeviceVault(workspace);
    const key = await importRecoveryKey((await createRecoveryBundle()).encryptionKey);
    await saveCloudRecoveryKey(key);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const request = vi.fn().mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ revision: 1, ciphertextDigest: body.ciphertextDigest }), { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);

    render(<ChatHelpApp />);
    await screen.findByRole("button", { name: "Open conversation with Recovery Contact" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Delete encrypted cloud backup" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/vault", expect.objectContaining({ method: "DELETE" })));
    expect(screen.getByRole("button", { name: "Open conversation with Recovery Contact" })).toBeTruthy();
    await waitFor(async () => expect((await openDeviceVault()).workspace.cloudRecovery.enabled).toBe(false));
    expect((await openDeviceVault()).workspace.contacts).toHaveLength(1);
    expect(await openCloudRecoveryKey()).toBeNull();
  }, 15_000);
});
