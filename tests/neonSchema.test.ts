import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveNeonContext } from "../cloudflare/worker/src/neonDb.js";

const env = {
  DEPLOYMENT_ENVIRONMENT: "testing",
  NEON_TESTING: { connectionString: "synthetic-testing-binding" },
  NEON_PRODUCTION: { connectionString: "synthetic-production-binding" },
};

describe("DialogMint cloud learning and usage Neon schema", () => {
  it("defines separate constrained learning usage and allowance products", () => {
    const sql = readFileSync("cloudflare/neon/0002_dialogmint_cloud_learning_usage.sql", "utf8");
    for (const table of [
      "dialogmint_learning_preferences",
      "dialogmint_learning_records",
      "dialogmint_ai_usage_attempts",
      "dialogmint_ai_allowances",
    ]) expect(sql).toContain("CREATE TABLE IF NOT EXISTS " + table);
    expect(sql).not.toContain("ALTER TABLE dialogmint_vault_snapshots");
    expect(sql).toContain("PRIMARY KEY (account_id, request_id, attempt_id)");
    expect(sql).toContain("UNIQUE (account_id, content_digest)");
  });

  it("defines a privacy-safe environment-scoped coordination row with bounded cleanup lookup", () => {
    const migration = "cloudflare/neon/0003_dialogmint_ai_usage_scopes.sql";
    expect(existsSync(migration)).toBe(true);
    const sql = readFileSync(migration, "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS dialogmint_ai_usage_scopes");
    expect(sql).toContain("PRIMARY KEY (account_id, provider, environment)");
    expect(sql).toMatch(/last_used_at\s+timestamptz\s+NOT NULL/iu);
    expect(sql).toMatch(/CHECK \(account_id ~ '\^\[0-9a-f\]\{64\}\$'\)/u);
    expect(sql).toMatch(/provider IN \('anthropic', 'workers_ai'\)/u);
    expect(sql).toMatch(/environment IN \('testing', 'production'\)/u);
    expect(sql).toMatch(/ON dialogmint_ai_usage_scopes \(environment, last_used_at\)/u);
    expect(sql).not.toMatch(/(?:email|conversation|message|draft|contact|model_id)/iu);
  });

  it("selects only the exact environment Hyperdrive binding", () => {
    expect(resolveNeonContext(env, "testing-chathelp-private-cloud.project-mission-ai.workers.dev"))
      .toEqual({ binding: env.NEON_TESTING, environment: "testing" });
    expect(() => resolveNeonContext(env, "attacker.example")).toThrow("unsupported_host");
  });
});
