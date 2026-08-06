import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudRecoveryTransportError, deleteCloudVault, readCloudVault, writeCloudVault } from "../src/lib/cloudRecoveryClient";
import type { CloudVaultEnvelopeV1 } from "../src/lib/cloudRecovery";

const envelope: CloudVaultEnvelopeV1 = {
  format: "dialogmint-cloud-v1",
  schemaVersion: 10,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AQ",
  encryptedBytes: 1,
  savedAt: "2026-08-05T00:00:00.000Z",
};
const digest = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

describe("DialogMint cloud recovery transport", () => {
  it("reads the same-origin encrypted vault without a bearer header", async () => {
    const request = vi.fn().mockResolvedValue(jsonResponse({ envelope, revision: 3, ciphertextDigest: digest }));
    await expect(readCloudVault(request)).resolves.toEqual({ envelope, revision: 3, ciphertextDigest: digest });

    expect(request).toHaveBeenCalledWith("/api/vault", expect.objectContaining({ method: "GET", credentials: "same-origin", cache: "no-store" }));
    const headers = request.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("writes create revision zero with a locally calculated ciphertext digest", async () => {
    const request = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ envelope, expectedRevision: 0, ciphertextDigest: digest });
      return jsonResponse({ revision: 1, ciphertextDigest: digest });
    });

    await expect(writeCloudVault(envelope, 0, request)).resolves.toEqual({ revision: 1, ciphertextDigest: digest });
    expect(request).toHaveBeenCalledWith("/api/vault", expect.objectContaining({ method: "PUT", credentials: "same-origin", cache: "no-store" }));
    expect((request.mock.calls[0][1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("deletes only the encrypted cloud backup through the authenticated origin", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deleteCloudVault(request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("/api/vault", expect.objectContaining({ method: "DELETE", credentials: "same-origin", cache: "no-store" }));
  });

  it("maps missing, conflicting, oversized, unavailable, and Access responses safely", async () => {
    await expect(readCloudVault(vi.fn().mockResolvedValue(jsonResponse({ error: "missing" }, 404)))).resolves.toBeNull();
    const cases: Array<[number, CloudRecoveryTransportError["code"]]> = [[401, "authentication"], [409, "conflict"], [413, "too-large"], [503, "unavailable"]];
    for (const [status, code] of cases) {
      const request = vi.fn().mockResolvedValue(jsonResponse({ error: "provider detail that must not escape" }, status));
      await expect(writeCloudVault(envelope, 2, request)).rejects.toMatchObject({ code });
    }
    const html = vi.fn().mockResolvedValue(new Response("<html>Cloudflare Access</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await expect(readCloudVault(html)).rejects.toMatchObject({ code: "authentication", message: expect.not.stringContaining("<html>") });
  });

  it("rejects invalid or excessively large JSON responses", async () => {
    const invalid = vi.fn().mockResolvedValue(jsonResponse({ envelope: { ...envelope, schemaVersion: 9 }, revision: 1, ciphertextDigest: digest }));
    await expect(readCloudVault(invalid)).rejects.toMatchObject({ code: "invalid" });
    const oversized = vi.fn().mockResolvedValue(new Response("x".repeat(11 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }));
    await expect(readCloudVault(oversized)).rejects.toMatchObject({ code: "too-large" });
  });
});
