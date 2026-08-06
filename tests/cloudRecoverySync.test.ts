import { describe, expect, it, vi } from "vitest";
import { createCloudSafeWorkspace, createRecoveryBundle, encryptCloudWorkspace, importRecoveryKey, summarizeCloudBackup } from "../src/lib/cloudRecovery";
import { synchronizeCloudWorkspace } from "../src/lib/cloudRecoverySync";
import { createEmptyWorkspace, type Contact, type WorkspaceData } from "../src/lib/workspaceTypes";

function contact(id: string, name: string): Contact {
  return {
    id, name, headline: "", profileNotes: "", platform: "linkedin", platformUrl: `https://www.linkedin.com/in/${id}`,
    profileUrl: `https://www.linkedin.com/in/${id}`, chat: [{ id: `message-${id}`, role: "them", body: `Hello from ${name}`, createdAt: "2026-08-04T00:00:00.000Z" }],
    documents: [], outcomes: [], retentionDays: 90,
  };
}

function workspaceWith(...contacts: Contact[]): WorkspaceData {
  const workspace = createEmptyWorkspace();
  workspace.cloudRecovery.enabled = true;
  workspace.contacts = contacts;
  return workspace;
}

async function recoveryKey() {
  return importRecoveryKey((await createRecoveryBundle()).encryptionKey);
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("DialogMint encrypted workspace synchronization", () => {
  it("stays off without network activity until encrypted backup is enabled", async () => {
    const workspace = createEmptyWorkspace();
    const request = vi.fn();
    const result = await synchronizeCloudWorkspace({ workspace, key: await recoveryKey(), environment: "testing", fetchImpl: request });
    expect(result.state.status).toBe("off");
    expect(request).not.toHaveBeenCalled();
  });

  it("recognizes an exact previously confirmed logical snapshot without rewriting it", async () => {
    const workspace = workspaceWith(contact("alex", "Alex"));
    const key = await recoveryKey();
    const safe = createCloudSafeWorkspace(workspace, "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    const envelope = await encryptCloudWorkspace(safe, key, "testing", "2026-08-05T00:00:00.000Z");
    const summary = await summarizeCloudBackup(safe, envelope);
    workspace.cloudRecovery = { enabled: true, revision: 5, lastConfirmedDigest: summary.logicalDigest, lastConfirmedCiphertextDigest: summary.ciphertextDigest, lastConfirmedContacts: 1, lastConfirmedMessages: 1, lastSyncedAt: "2026-08-05T00:00:00.000Z" };
    const request = vi.fn();

    const result = await synchronizeCloudWorkspace({ workspace, key, environment: "testing", fetchImpl: request, now: () => new Date("2026-08-05T00:00:00.000Z") });
    expect(result.state).toMatchObject({ status: "synced", contactCount: 1, messageCount: 1 });
    expect(request).not.toHaveBeenCalled();
  });

  it("records only an exact Neon write confirmation as synced", async () => {
    const workspace = workspaceWith(contact("alex", "Alex"));
    const request = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      return jsonResponse({ revision: 1, ciphertextDigest: body.ciphertextDigest });
    });
    const result = await synchronizeCloudWorkspace({ workspace, key: await recoveryKey(), environment: "testing", fetchImpl: request, now: () => new Date("2026-08-05T00:00:00.000Z") });

    expect(result.state).toMatchObject({ status: "synced", contactCount: 1, messageCount: 1, revision: 1 });
    expect(result.workspace.cloudRecovery).toMatchObject({ revision: 1, lastConfirmedContacts: 1, lastConfirmedMessages: 1, lastSyncedAt: "2026-08-05T00:00:00.000Z" });
    expect(result.workspace.cloudRecovery.lastConfirmedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.workspace.cloudRecovery.lastConfirmedCiphertextDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads, decrypts, merges, and retries exactly once after a revision conflict", async () => {
    const key = await recoveryKey();
    const local = workspaceWith(contact("local", "Local"));
    const remoteSafe = createCloudSafeWorkspace(workspaceWith(contact("remote", "Remote")), "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    const remoteEnvelope = await encryptCloudWorkspace(remoteSafe, key, "testing", "2026-08-05T00:00:00.000Z");
    const remoteSummary = await summarizeCloudBackup(remoteSafe, remoteEnvelope);
    let putCount = 0;
    const request = vi.fn().mockImplementation(async (_url, init) => {
      if (init.method === "GET") return jsonResponse({ envelope: remoteEnvelope, revision: 3, ciphertextDigest: remoteSummary.ciphertextDigest });
      putCount += 1;
      if (putCount === 1) return jsonResponse({ error: "conflict" }, 409);
      const body = JSON.parse(String(init.body));
      expect(body.expectedRevision).toBe(3);
      return jsonResponse({ revision: 4, ciphertextDigest: body.ciphertextDigest });
    });

    const result = await synchronizeCloudWorkspace({ workspace: local, key, environment: "testing", fetchImpl: request, now: () => new Date("2026-08-05T00:00:00.000Z") });
    expect(result.state).toMatchObject({ status: "synced", revision: 4, contactCount: 2, messageCount: 2 });
    expect(result.workspace.contacts.map((item) => item.id).sort()).toEqual(["local", "remote"]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("stops after a second conflict while preserving the merged local state", async () => {
    const key = await recoveryKey();
    const local = workspaceWith(contact("local", "Local"));
    const remoteSafe = createCloudSafeWorkspace(workspaceWith(contact("remote", "Remote")), "testing", Date.parse("2026-08-05T00:00:00.000Z"));
    const remoteEnvelope = await encryptCloudWorkspace(remoteSafe, key, "testing", "2026-08-05T00:00:00.000Z");
    const remoteSummary = await summarizeCloudBackup(remoteSafe, remoteEnvelope);
    const request = vi.fn().mockImplementation(async (_url, init) => init.method === "GET"
      ? jsonResponse({ envelope: remoteEnvelope, revision: 3, ciphertextDigest: remoteSummary.ciphertextDigest })
      : jsonResponse({ error: "conflict" }, 409));

    const result = await synchronizeCloudWorkspace({ workspace: local, key, environment: "testing", fetchImpl: request, now: () => new Date("2026-08-05T00:00:00.000Z") });
    expect(result.state.status).toBe("needs-attention");
    expect(result.workspace.contacts.map((item) => item.id).sort()).toEqual(["local", "remote"]);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
