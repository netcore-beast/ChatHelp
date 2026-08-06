import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredVaults, handleVaultRequest, resolveVaultBinding } from "../cloudflare/worker/src/neonVault.js";

const TESTING_HOST = "testing-chathelp-private-cloud.project-mission-ai.workers.dev";
const PRODUCTION_HOST = "chathelp-private-cloud.project-mission-ai.workers.dev";
const ACCOUNT_ID = "a".repeat(64);

const envelope = {
  format: "dialogmint-cloud-v1",
  schemaVersion: 10,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "AQ",
  encryptedBytes: 1,
  savedAt: "2026-08-05T00:00:00.000Z",
};
const ciphertextDigest = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");

function env() {
  return {
    NEON_TESTING: { connectionString: "synthetic-testing-binding" },
    NEON_PRODUCTION: { connectionString: "synthetic-production-binding" },
  };
}

function vaultRequest(method: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(`https://${TESTING_HOST}/api/vault`, {
    method,
    headers: body === undefined ? extraHeaders : { "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("DialogMint Neon vault Worker boundary", () => {
  it("defines one opaque expiring snapshot row and no readable conversation columns", () => {
    const sql = readFileSync("cloudflare/neon/0001_dialogmint_vault.sql", "utf8");
    for (const field of ["account_id text PRIMARY KEY", "format_version integer NOT NULL", "schema_version integer NOT NULL", "revision bigint NOT NULL", "ciphertext jsonb NOT NULL", "ciphertext_digest text NOT NULL", "encrypted_bytes integer NOT NULL", "created_at timestamptz NOT NULL", "updated_at timestamptz NOT NULL", "expires_at timestamptz NOT NULL"]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain("CHECK (revision > 0)");
    expect(sql).toContain("CHECK (encrypted_bytes > 0 AND encrypted_bytes <= 10485760)");
    expect(sql).toContain("dialogmint_vault_snapshots_expiry_idx");
    expect(sql).not.toMatch(/contact_name|message_text|email|access_token|recovery_key/i);
  });

  it("selects only the exact environment binding", () => {
    const bindings = env();
    expect(resolveVaultBinding(TESTING_HOST, bindings)).toBe(bindings.NEON_TESTING);
    expect(resolveVaultBinding(PRODUCTION_HOST, bindings)).toBe(bindings.NEON_PRODUCTION);
    expect(resolveVaultBinding("preview-123.chathelp-private-cloud.workers.dev", bindings)).toBeNull();
    expect(resolveVaultBinding("dialogmint.com.attacker.example", bindings)).toBeNull();
  });

  it("reads only an unexpired authenticated row using a parameterized account ID", async () => {
    const bindings = env();
    const query = vi.fn().mockResolvedValue({ rows: [{ ciphertext: envelope, revision: "4", ciphertext_digest: ciphertextDigest }], rowCount: 1 });
    const response = await handleVaultRequest(vaultRequest("GET"), bindings, new URL(`https://${TESTING_HOST}/api/vault`), { accountId: ACCOUNT_ID, environment: "testing" }, { query });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ envelope, revision: 4, ciphertextDigest });
    expect(query).toHaveBeenCalledTimes(1);
    const [binding, sql, values] = query.mock.calls[0];
    expect(binding).toBe(bindings.NEON_TESTING);
    expect(sql).toContain("expires_at > now()");
    expect(sql).not.toContain(ACCOUNT_ID);
    expect(values).toEqual([ACCOUNT_ID]);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 404 for an absent or expired row without exposing identity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = await handleVaultRequest(vaultRequest("GET"), env(), new URL(`https://${TESTING_HOST}/api/vault`), { accountId: ACCOUNT_ID, environment: "testing" }, { query });
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({ error: "Encrypted backup not found." });
  });

  it("validates format, schema, revision, digest, content type, and the 10 MiB request limit before querying", async () => {
    const query = vi.fn();
    const identity = { accountId: ACCOUNT_ID, environment: "testing" as const };
    const url = new URL(`https://${TESTING_HOST}/api/vault`);
    const cases = [
      vaultRequest("PUT", { envelope: { ...envelope, schemaVersion: 9 }, expectedRevision: 0, ciphertextDigest }),
      vaultRequest("PUT", { envelope, expectedRevision: -1, ciphertextDigest }),
      vaultRequest("PUT", { envelope, expectedRevision: 0, ciphertextDigest: "not-a-digest" }),
      new Request(url, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" }),
      new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", "Content-Length": String(10 * 1024 * 1024 + 1) }, body: "{}" }),
    ];

    const statuses = [];
    for (const request of cases) statuses.push((await handleVaultRequest(request, env(), url, identity, { query }))?.status);
    expect(statuses).toEqual([400, 400, 400, 415, 413]);
    expect(query).not.toHaveBeenCalled();
  });

  it("creates and conditionally updates revisions in one parameterized statement", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ revision: "1", ciphertext_digest: ciphertextDigest }], rowCount: 1 });
    const response = await handleVaultRequest(vaultRequest("PUT", { envelope, expectedRevision: 0, ciphertextDigest }), env(), new URL(`https://${TESTING_HOST}/api/vault`), { accountId: ACCOUNT_ID, environment: "testing" }, { query });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ revision: 1, ciphertextDigest });
    const [, sql, values] = query.mock.calls[0];
    expect(sql).toContain("WITH updated AS");
    expect(sql).toContain("interval '90 days'");
    expect(sql).toContain("WHERE $7 = 0");
    expect(sql).not.toContain(ACCOUNT_ID);
    expect(sql).not.toContain(ciphertextDigest);
    expect(values).toEqual([ACCOUNT_ID, 1, 10, envelope, ciphertextDigest, 1, 0]);
  });

  it("returns a revision conflict without retrying or overwriting", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const response = await handleVaultRequest(vaultRequest("PUT", { envelope, expectedRevision: 7, ciphertextDigest }), env(), new URL(`https://${TESTING_HOST}/api/vault`), { accountId: ACCOUNT_ID, environment: "testing" }, { query });
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({ error: "Encrypted backup changed on another device." });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("deletes only the authenticated row", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const response = await handleVaultRequest(vaultRequest("DELETE"), env(), new URL(`https://${TESTING_HOST}/api/vault`), { accountId: ACCOUNT_ID, environment: "testing" }, { query });
    expect(response?.status).toBe(204);
    const [, sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM dialogmint_vault_snapshots\s+WHERE account_id = \$1/);
    expect(sql).not.toContain(ACCOUNT_ID);
    expect(values).toEqual([ACCOUNT_ID]);
  });

  it("cleans both environments and continues after one environment fails", async () => {
    const bindings = env();
    const query = vi.fn().mockImplementation(async (binding) => {
      if (binding === bindings.NEON_TESTING) throw new Error("synthetic database failure");
      return { rows: [], rowCount: 3 };
    });
    const result = await cleanupExpiredVaults(bindings, { query });

    expect(result).toEqual({ testing: 0, production: 3 });
    expect(query).toHaveBeenCalledTimes(2);
    for (const [, sql, values] of query.mock.calls) {
      expect(sql).toContain("DELETE FROM dialogmint_vault_snapshots WHERE expires_at <= now()");
      expect(values).toEqual([]);
    }
  });
});
